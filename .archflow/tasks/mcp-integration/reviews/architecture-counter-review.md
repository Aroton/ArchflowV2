# Counter-Review: MCP Integration Architecture

> Adversarial review of [architecture.md](../architecture.md) against [prd.md](../prd.md), the current repository, and the installed Claude Code / Codex CLIs.
>
> Reviewer context: fresh read; no access to the drafting conversation or the two prior review rounds.

## Method and evidence base

Claims were checked against live artifacts rather than recollection:

- Every pinned dependency was resolved against the npm registry (`npm view <pkg> version`).
- `claude --help` / `claude mcp add --help` on **Claude Code 2.1.220**.
- `codex --help` / `codex exec --help` / `codex sandbox --help` / `codex mcp add --help` on **codex-cli 0.145.0**.
- `execa@10.0.0` was unpacked and its option typings read directly.
- Codex's own `read-only` sandbox was exercised against real credential and repository paths (results in Blocker 2).
- Requirement-to-phase coverage was recomputed by hand from the 13 phase requirement lists.

**Version pins are accurate and should not be re-litigated.** `@modelcontextprotocol/server@2.0.0-beta.5`, `typescript@7.0.2`, `zod@4.4.3`, `ajv@8.20.0`, `yaml@2.9.0`, `execa@10.0.0`, `write-file-atomic@8.0.0`, `proper-lockfile@4.1.2`, `esbuild@0.28.1`, `vitest@4.1.10` all exist and are current latest. Node `24.18.0` is a real release and is the current v24 head. The CLI flags the adapters depend on all exist: Claude `--safe-mode`, `--tools`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, `--json-schema`; Codex `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--sandbox read-only`, `--output-schema`, `--json`, `-C/--cd`. Requirement coverage is genuinely complete: **all of REQ-01–41 and REQ-50 appear in at least one phase's requirement list**, and VAL-01–17 all appear in the coverage table. The prior rounds did that work well.

What follows is what survived.

---

## Blockers

### B-1 — The two premises that can invalidate the whole design are proven last

**Evidence.** The PRD is explicit: "VAL-02 is the decisive product validation: if independent review does not reliably improve substantive quality, the architecture's central automation premise must be revisited rather than hidden by more mechanics" (prd.md, after the VAL table). The architecture agrees — Testing and Release Strategy item 5: "If `VAL-02` does not demonstrate useful independent review, the automation premise is revisited rather than compensated for with more mechanics."

It then schedules that test in **Phase 12 of 13**, after content-addressed storage, checkpoint chains, gate/waiver lifecycles, the sandbox provider, the five-tool assembly, the installer, eight rewritten skills, the manual-mode workflow, and the legacy upgrade pipeline are all built. The second existential item — provable launcher-versus-model credential confinement (Phase 4) — is likewise gated behind Phases 1–3, and its failure mode is "the environment is unsupported," i.e. the product does not ship there.

The architecture therefore maximizes sunk cost before its own go/no-go. Every phase dependency is a straight chain (`Depends on: Phases 1–N`), so there is no path where the premise test lands earlier by accident.

**Why this is a blocker and not a preference.** The PRD's response to VAL-02 failure is "revisit the architecture," not "adjust a threshold." An architecture whose stated failure mode requires discarding twelve phases of work has mis-ordered its risk.

**Suggested resolution.** Insert a Phase 0 feasibility spike, explicitly throwaway, with no durable-state machinery: hand-driven `claude -p` and `codex exec` calls in both directions over a small seeded-defect corpus, plus the credential-confinement probe from B-2. Gate Phases 1–13 on it. Its success criteria are VAL-02's substance and B-2's proof; its artifacts are a report and a decision, not code. If the spike fails, the loss is days rather than the whole plan.

### B-2 — Codex cannot be made credential-safe with the mechanisms the architecture names, and there is no contingency

**Evidence.** The architecture requires the sandbox provider to "prove that model-controlled descendants/tools cannot read or emit subscription tokens, auth files, credential file descriptors, keychain neighbors, or unrelated credentials," and offers three escape hatches: "a proven no-tool invocation or a narrowly scoped credential broker/parent-versus-descendant confinement."

For the Claude reviewer, a no-tool invocation exists and is named: `--tools ""` ("Use `\"\"` to disable all tools" — `claude --help`, verified on 2.1.220). For the Codex reviewer, **none of the three exists**:

1. *No-tool invocation.* `codex exec --help` (0.145.0) exposes no flag that disables the shell/exec tool. The architecture's Codex flag list (`--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--sandbox read-only`, `--output-schema`) contains no such control, and none was found in `codex --help`, `codex exec --help`, `codex features`, or `codex debug`.
2. *Credential broker.* Codex subscription auth is a file (`$CODEX_HOME/auth.json`, present here at 4167 bytes, mode `-rw-------`). There is no documented interface to inject it out-of-band; the only non-file path is `OPENAI_API_KEY`, which REQ-34 forbids.
3. *Parent-versus-descendant confinement.* The named preferred provider (`@anthropic-ai/sandbox-runtime`) uses bubblewrap on Linux. The launcher must be able to read `auth.json` to authenticate, so it must be bind-mounted into the namespace — and the model's shell tool is a descendant **inside that same mount namespace**. A bind-mount sandbox cannot grant a path to a process and deny it to that process's own children.

Measured directly, from a temp cwd outside the repository, under Codex's own `read-only` sandbox:

```
$ codex sandbox -c sandbox_mode='"read-only"' -- sh -c 'wc -c < "$HOME/.codex/auth.json"'
4167                    # own subscription credentials: READABLE
$ codex sandbox -c sandbox_mode='"read-only"' -- sh -c 'wc -c < "$HOME/.claude/.credentials.json"'
509                     # the OTHER client's credentials: READABLE
$ codex sandbox -c sandbox_mode='"read-only"' -- sh -c 'wc -c < .../mcp-server/CLAUDE.md'
4531                    # arbitrary repository file by absolute path: READABLE
$ codex sandbox -c sandbox_mode='"read-only"' -- sh -c 'echo x > .../mcp-server/CANARY.txt'
sh: 1: cannot create ...: Read-only file system      # writes: BLOCKED
```

This confirms the architecture's own caution that `--sandbox read-only` "is defense-in-depth, not the repository-read boundary" — but it also shows the exposure includes the *other family's* credentials, and that read-only blocks only writes.

**Consequence.** Under the architecture's fail-closed rule ("If a Codex/host/provider combination cannot prove launcher-versus-model credential separation, it is unsupported"), the Claude-producer → Codex-reviewer direction is likely unsupported on every OS. Same-family fallback is a hard `FAMILY_MISMATCH` by design. So one of the two directions required by REQ-31, VAL-07, and Phase 12's success criteria has no delivery path, and the architecture defines no contingency — Phase 4 simply marks a matrix entry unsupported and Phase 12 still asserts "Both producer directions prove...".

**Suggested resolution.** Three concrete moves, in order:

1. **Reconsider `--ignore-rules`.** It is listed among Codex isolation flags, but its documented effect is "Do not load user or project execpolicy `.rules` files" — it *removes* the only user-configurable command-restriction layer. A purpose-built ArchFlow execpolicy that denies every command, supplied via a generated `CODEX_HOME`, is the closest thing to a `--tools ""` equivalent Codex offers. Isolating from the user's rules and shipping ArchFlow's own deny-all rules are different goals; the current flag list achieves the first at the cost of the second.
2. Move this probe into Phase 0 (B-1) so the answer is known before Phases 1–3 are built.
3. Decide and document the contingency now: if Codex-as-reviewer cannot be confined, does v1 ship Codex-producer → Claude-reviewer only (and how do REQ-31/VAL-07/Phase 12 change), or does the release block? Today the architecture's answer is an unstated "unsupported," which silently deletes half the product.

### B-3 — The `intent_id` / `expected_revision` / request-digest contract is self-contradictory on the paths the design relies on most

**Evidence.** The mutation sequence fixes three rules: step 4, "A replay succeeds only when current validated state references the committed intent, result, and resulting revision... changed reuse returns `INTENT_MISMATCH`"; step 5, "Compare `expected_revision`; a mismatch returns `STATE_CONFLICT`"; and the Intent receipt row, "Intent ID, canonical request digest, prior/result revision...". The set of fields inside the "canonical request digest" is never defined.

That omission breaks two flows the architecture explicitly requires:

*Supplemental-review retry.* `SUPPLEMENTAL_REVIEW_REQUIRED` is described as "retryable non-success" while "the gate remains pending," and "The resumed orchestrator triages it." Triage is a state transition, so it advances the revision. The retried `archflow_gate` call must therefore carry a **new** `expected_revision`. If `expected_revision` is inside the canonical request digest, that retry is "changed reuse" → `INTENT_MISMATCH`, and the pending gate can never be resumed. If it is outside, then step 5's CAS behavior on a replayed intent is undefined — a replay would be validated against a revision the receipt does not bind.

*Gate supersession.* On an accepted supplemental finding the gate closes as `superseded`, the artifact is rewritten, and the design "creates a new digest/new deterministic gate." Gate IDs derive from "canonical task identity, `intent_id`, and request digest," so a new gate ID follows from either a new digest or a new intent. But if the skill reuses the intent (the natural reading of "the same logical operation"), the changed subject digest makes it `INTENT_MISMATCH`. The architecture never says a fresh `intent_id` is required here.

The same ambiguity applies to every mutating call that is legitimately retried after an intervening transition — which, given that reconciliation runs "before every request," is the common case, not the edge case.

**Suggested resolution.** In the Five-Tool MCP API Boundary section, define the canonical request digest as an explicit closed field list; exclude `expected_revision` from it and state that CAS is evaluated independently of intent identity; and state the intent lifecycle rule directly — a retry after `SUPPLEMENTAL_REVIEW_REQUIRED` reuses the intent with a refreshed `expected_revision`, while a superseded gate requires a fresh `intent_id`. Add a Phase 3 success criterion covering retry-after-intervening-transition, since no current criterion exercises it.

---

## Majors

### M-1 — Declared-input fingerprint scope invalidates unrelated approved work, and pinned config has no amendment path

**Evidence.** The fingerprint is defined as a "Hash of versioned workflow/config, pinned constitution, artifact/upstream bytes, rubric, phase instance, and explicitly declared inputs." REQ-25 and the architecture agree that "a changed fingerprint creates a new retained result." REQ-30 permits a human or Archforge to write per-task `config.yaml` to "override models/effort by role and phase."

So editing the adjudicator's effort level changes `config.yaml`, which changes the fingerprint of every step in the task — including the already-approved PRD and design — forcing new authoritative results for documents whose content and inputs did not change. Meanwhile REQ-04 pins the config digest at task start and the architecture makes mismatched policy bases "fail closed," so there is also no legal way to make that edit: the task either rejects it or invalidates itself.

**Suggested resolution.** Narrow the fingerprint to the inputs a step actually consumes — for a dispatch step, the resolved routing entry for that role/phase rather than the whole file; for a document step, no routing input at all. Separately, define an explicit config-amendment transition (a gate kind) that re-pins the digest and states precisely which retained results it invalidates.

### M-2 — REQ-01's `.mcp.json` is not delivered by the registration approach, and the alternative leaks a machine path into the user's repository

**Evidence.** REQ-01 states initialization scaffolds "host registration needed for terminal operation, **including `.mcp.json` for Claude Code** and `~/.codex/config.toml` for Codex." The architecture instead says "Registration prefers official `claude mcp add` and `codex mcp add` commands" and never names a scope.

Verified: `claude mcp add --help` shows `-s, --scope <scope>  Configuration scope (local, user, or project) (default: "local")`. The default writes to the user-level store, **not** `.mcp.json`; only `--scope project` produces `.mcp.json`. As written, REQ-01's Claude half is unmet.

Choosing `--scope project` creates the opposite problem. `.mcp.json` is a tracked repository file that outlives the pre-PR deletion of `.archflow/`, and it must contain the absolute path to the installed `archflow-mcp` launcher — which directly contradicts the architecture's own rule that "Machine-specific executable locations stay in host registration, never portable task state," and would ship one developer's `$HOME` path to everyone who clones the repo.

**Suggested resolution.** Decide and state the scope. If project scope is required by REQ-01, resolve the path problem explicitly (a launcher on `PATH`, or a documented `${ARCHFLOW_MCP}` indirection) and say whether `.mcp.json` is committed or gitignored. Add a Phase 7 success criterion naming `.mcp.json` — the current criteria say only "Official Claude and Codex registrations use the stable launcher."

### M-3 — Content digests are defined without reference to Git's text normalization

**Evidence.** This repository already ships `.gitattributes` containing `* text=auto`. The architecture's entire evidence model rests on digests of file bytes — "artifact/upstream bytes," "before/after digests," "exact canonical diff digest," "byte-identical declared outputs" — and its handoff model is explicitly commit → push → clean pull into a different worktree or clone: "handoff requires an explicit human-approved checkpoint commit and push, a clean pull by the next writer, and identity/revision/conflict checks before mutation."

The document never states whether a digest is taken over Git **blob** bytes or over **worktree** bytes, and never mentions `text=auto`, `core.autocrlf`, `core.fileMode`, or symlink checkout behavior. Under `text=auto`, worktree bytes and blob bytes differ whenever normalization applies, and differ *between clones* depending on the puller's config. The implementation-output manifest specifically binds "regular/symlink file type, executable mode, and binary-safe bytes" — all three are things Git checkout can legitimately change across machines. The consequence is a handoff that fails digest validation, or worse, a byte-identical "restore" that writes the wrong line endings.

**Suggested resolution.** State the rule: committed policy inputs (constitution, workflow) digest over Git blob bytes read from the pinned commit; task artifacts and implementation outputs digest over raw worktree bytes with normalization disabled for `.archflow/` (ship `.archflow/** -text` in `.gitattributes`, and treat snapshot payloads as binary). Add checkout-normalization and `core.fileMode` cases to the Phase 2 path/manifest criteria and the Phase 11 matrix — neither currently mentions Git normalization at all.

### M-4 — REQ-41's supplemental review has no defined producer while the orchestrator is blocked

**Evidence.** `archflow_gate` "publishes and commits the request before it waits," and the wait ends with `SUPPLEMENTAL_REVIEW_REQUIRED` "If an untriaged supplemental review arrives." But a blocking MCP tool call occupies the orchestrator's turn — the agent that would write `reviews/<phase-instance>.gate-counter.<gate-id>.md` is precisely the agent that is blocked. The architecture never names who creates that file.

The gap is not merely bookkeeping. REQ-11 requires structured JSON that "validates before Markdown rendering," and the architecture repeats that "Model JSON must validate before it can become evidence." A human pasting the other client's output into a file does not produce validating JSON, and the architecture never states that `archflow-local validate/render` is the normal-mode path for this (its description of `archflow-local` is framed as the server-unavailable helper). Three further mechanics are undefined: whether `archflow_state` transitions are legal while a gate is pending (triage requires it); how the blocked server *detects* the file's arrival (poll interval? watch? at what cost given "reconciliation runs before every request"); and what happens if the file appears mid-write.

**Suggested resolution.** Name the actor and the path explicitly — most plausibly: the gate prompt instructs the other client to emit JSON to stdout, the human saves it, and `archflow-local` validates/renders/binds it in normal mode too. State that gate-pending state transitions are legal and enumerate which ones. Define the detection mechanism and its atomicity requirement. Add this end-to-end path to Phase 8's criteria, which currently assert the return code without saying how the file got there.

### M-5 — The one-writer invariant has no enforcement mechanism, but Phase 11 claims a test for it

**Evidence.** The architecture is candid that "Locking and revision CAS coordinate only processes sharing the same filesystem. Git is transport and history, not a distributed lock," and then asserts "One active writer/worktree owns a task branch." Phase 11's success criteria promise "independent clones are rejected until a clean checkpoint handoff," and Phase 2's promise "Separate-clone tests reject concurrent mutation."

No mechanism is described that could reject them. Two clones each hold `state.json` at revision *N*; each takes its own local lock, passes its own CAS against its own copy, and writes revision *N+1* with different content. Nothing in the described design detects the other. REQ-24 — a Must Have — says "Multiple Claude/Codex/Archforge sessions cannot silently overwrite one task's state"; a second clone can, and the divergence surfaces only as a Git merge conflict later.

Relatedly, the architecture never addresses what a merge conflict in `.archflow/` means. `state.json`, checkpoint files, and intent receipts are content that must not be textually merged, and there is no `merge=` strategy, conflict-detection rule, or repair procedure anywhere in the document.

**Suggested resolution.** Either (a) add a real mechanism — a writer lease committed into `state.json` (writer identity + acquisition revision) plus a handoff transition that is the only way to change it, with mutation refused when the lease names another writer; or (b) drop the claim, state plainly that cross-clone concurrency is undetectable by design, and replace the two test criteria with Git-merge-conflict *detection and repair* criteria. Either way, specify `.archflow/** merge=binary` (or equivalent) and a documented conflict repair path.

### M-6 — Manual mode's independence is asserted rather than established, and it roughly doubles the build

**Evidence.** The architecture states: "'Server unavailable' means this helper remains available." But `archflow-local` is, by the same paragraph, "CLI/library functions from the **same installed bundle**" — same Node runtime, same esbuild output, same schemas, same code. The failure classes where the server is unavailable *and* the helper is not are narrow: broken host MCP registration, a host that disables the server, an MCP transport/protocol fault, or an exhausted tool timeout. Every failure that kills the bundle, the launcher, or Node kills both, which the architecture concedes in the next sentence ("If both server and helper are unavailable, skills fail non-advancing").

Against that narrow class, the design commits to: immutable checkpoint chains with predecessor digests, greatest-valid-chain semantics, `manual-checkpoint-import` as a first-class union member with checkpoint-1 initialization constraints, degraded status reconstruction, exact per-tool fallback templates, a manual legacy-upgrade path, and manual matrices in Phases 3, 9, 10, 11, and 12. Phase 9 in effect reimplements the entire workflow a second time as skill instructions. This is the single largest cost item in the architecture and it is justified by an unexamined assumption about independent failure.

The PRD does require it (REQ-38–REQ-40), so the architecture cannot unilaterally drop it — but it can and should surface the cost and the narrowness so the owner can decide.

**Suggested resolution.** Add an explicit paragraph enumerating the failure classes manual mode covers and the (larger) set it does not, so "complete manual fallback" is not over-claimed. Then put the trade to the user as a scope question: is full manual *completion* (REQ-39, reaching task completion with the server never recovering) worth roughly a doubling of surface area versus manual *pause-and-repair*? That is an owner decision, not an architectural one, but it should be made before Phase 3 rather than discovered in Phase 9.

### M-7 — A restore collision is an unresolvable deadlock with no human escape hatch

**Evidence.** REQ-25 requires that an unchanged fingerprint "restores/reuses the exact previously validated authoritative output bytes"; the architecture makes restore "collision-safe, refuses undeclared changes" and states "ambiguity is non-advancing in both normal and manual modes."

Take the ordinary case: a developer edits a source file that a completed phase declared as an output, then reruns the phase. The fingerprint is unchanged, so regeneration is forbidden. Restore detects a before-image mismatch, so restore is refused. The task cannot advance and cannot retreat. The gate trigger list — "Trigger/uncertainty, material drift, failed adjudication, attempts exhaustion, waivers, and task-branch constitution edits gate" — does not include restore collision, so the design's own escape valve is unavailable.

**Suggested resolution.** Add a `restore-collision` gate kind with explicit, enumerated human decisions (accept worktree bytes as a new generation with a recorded rationale; discard worktree bytes and restore; abort). Add it to the gate kinds in Phase 3 and to the dirty-worktree criteria in Phases 2 and 12, which currently test only the clean-restore path.

### M-8 — Phase 2 is the system, not a phase; Phases 11–12 duplicate proof obligations already owned earlier

**Evidence.** Phase 2's scope is a single sentence containing: Git/worktree and task identity, path allowlists, six schemas, revision-0→1 adoption, fingerprints, lock/CAS, prepared receipts, immutable snapshots, atomic projections, state-last commitment, implementation bindings, collision-safe restore, and reconciliation — behind seven checkboxes. That is the durable core of the entire product in one phase, and the ArchFlow phase model (`DESIGNED → IN PROGRESS → COMPLETE` with a single design gate and a single commit authorization) has no way to review it incrementally.

Symmetrically, Phases 11 and 12 restate obligations already claimed as success criteria elsewhere. Phase 2 asserts "Fault injection **before/during/after every** snapshot/projection/state write"; Phase 11 then asserts "Complete fault injection at every durable boundary." Phase 4 asserts a randomized black-box sandbox proof; Phase 11 asserts credential canaries again. When two phases claim the same proof, either can be marked COMPLETE while deferring the hard half to the other — which is exactly the failure the state machine exists to prevent.

Finally, every phase depends on all its predecessors and nothing produces an end-to-end usable increment until Phase 8 of 13. For a tool the team dogfoods, that is a long time with no feedback.

**Suggested resolution.** Split Phase 2 along its natural seam (identity + paths + schemas; then lock/CAS + prepared/commit + reconciliation; then snapshots + implementation manifests + restore). Re-frame Phases 11–12 as *matrix expansion* over criteria owned by earlier phases, with each restated criterion naming its owning phase, so the boundary is "Phase 4 proved one configuration; Phase 11 proves the matrix." Consider a thin vertical slice — one document phase, produce → counter-review → gate → approve, no manual mode, no upgrade — landing before Phase 5.

### M-9 — The snapshot store has no size bound, retention policy, or exclusion rule

**Evidence.** `results/sha256/<result-digest>/payload/<declared-output-path>` retains "exact output bytes" for every result, snapshots are "immutable after creation," and all of it is "ordinary files checked into Git with the task on its shared branch." The implementation-output manifest binds "binary bytes" of declared source paths with before/after images.

So for every implementation phase, the task branch gains a second full copy of the changed source files — inside the repository that already stores them, in Git, in a directory whose only cleanup is wholesale deletion before PR. Every rewrite in the fixed-point loop ("Accepted findings across two rewrites") adds another retained generation. Add `attempts/`, `intents/`, `manual/checkpoints/`, and `imports/<import-digest>/payload/`, and the growth is unbounded and unmeasured — no size cap, no GC, no exclusion for large or binary files, and no performance criterion anywhere in the document.

There is a second-order concern: a secret accidentally committed once now exists in at least two Git-tracked locations, and the deletion story ("`.archflow/` is removed before PR") removes it from the tree but not from branch history.

**Suggested resolution.** Bound it explicitly: for outputs that are already tracked Git content, store the blob OID and digest rather than a byte copy, and reserve payload copies for untracked or generated artifacts; cap payload size with a stated failure mode; define retention for `attempts/` and superseded results. Add a criterion measuring `.archflow/` growth across a representative multi-phase task.

### M-10 — Two schema systems describe the same shapes with no stated source of truth

**Evidence.** The stack table assigns Zod 4 to "MCP request/result schemas" and JSON Schema 2020-12 + Ajv strict to "durable schemas," and the directory layout mirrors that split (`contracts/mcp.ts` vs `contracts/schemas/`). But the shapes overlap: `archflow_state.artifact` is simultaneously an MCP request field (Zod, published in `tools/list`) and a durable manifest (`implementation-manifest.ts`, `legacy-import-manifest.ts`, JSON Schema). Review results, checkpoints, and decisions are likewise both wire payloads and files.

No generation direction is specified and no conformance test is required. The divergence failure is fail-*open*: the server advertises and accepts a request the Zod schema permits, then fails to persist it because the Ajv schema rejects it — after the caller has been told the shape is valid. Phase 1's criteria cover round-tripping and rejection within each system, never agreement between them.

**Suggested resolution.** Pick one source of truth — Zod as authoring surface, JSON Schema generated from it (`z.toJSONSchema`) for durable files and for the published tool schemas — or keep both and add a Phase 1 success criterion that proves, for every shared type, that the two schemas accept and reject identical corpora.

### M-11 — `archflow-init` cannot set the timeout it is required to configure

**Evidence.** REQ-36 says "Supported-host installation documents/configures a human-decision tool-timeout window." The architecture's mechanism is "the Claude server entry's persistent per-server `timeout` when supported; otherwise it requires and validates an inherited `MCP_TOOL_TIMEOUT` environment variable."

Verified: `claude mcp add --help` on 2.1.220 exposes no timeout option at all (`--callback-port`, `--client-id`, `--client-secret`, `-e/--env`, `-H/--header`, `-s/--scope`, `-t/--transport`). Claude Code's tool timeout is an environment variable of the **host** process. `archflow-init` runs as a child; it can validate that the variable is present but cannot durably set it — the "otherwise" branch therefore reduces to "fail initialization unless the user has already exported it in their shell profile," which the architecture never says.

The consequence path is also undescribed: if the variable is absent or short, a gate call hits the host tool timeout, the gate stays pending (correct), the agent receives an error, and must re-call — a retry loop that is the *designed* behavior but appears nowhere as such, and is not exercised by any success criterion.

**Suggested resolution.** State the shell-profile guidance init emits, state that init fails closed when the variable is absent, and describe timeout-then-resume as supported normal-mode behavior. Add a Phase 3 or Phase 6 criterion that a gate survives a real host tool timeout and resumes on the next call at the *default* timeout, since that is what most users will run with. (I did not verify whether a `timeout` key is honored inside a Claude MCP server entry — the "when supported" hedge is prudent, but the fallback branch needs the detail above regardless.)

---

## Minors

### m-1 — Coverage table and phase requirement lists disagree

The coverage table lists Phase 11 under "Host identity and routing (REQ-29, REQ-30, REQ-31)" and Phase 6 under "Degraded/manual terminal completion (REQ-38, REQ-39, REQ-40)," but Phase 11's requirement list omits REQ-30 and Phase 6's omits REQ-38/39/40. The table is presented as the audit artifact ("All v1 requirements... appear above"), so the two directions should be reconciled or the table generated from the phase lists.

### m-2 — The Node `24.18.0` floor has no stated cause

`24.18.0` is real and is the current v24 head — i.e. the floor is "whatever was newest at drafting time." It excludes 24.11–24.17 users for no documented reason and will be stale before release. A minimum should cite the feature or security fix that requires it, or be expressed as a policy ("current v24 LTS at release, minimum X because Y").

### m-3 — `@types/node` is pinned older than the runtime floor

`@types/node@24.13.3` against a Node `24.18.0` runtime (latest published is `26.1.1`). Harmless, but the pairing rule should be stated so a future upgrade does not read it as an error.

### m-4 — `killDescendants` is documented as best-effort, and no phase requires a kill-group primitive

From `execa@10.0.0`'s own typings: "When the subprocess is terminated by Execa, also terminate all of its descendant processes... **This is best-effort: descendant processes that create their own process group or session are not terminated.**" The stack table presents it as the mechanism and defers the residue to "sandbox/cgroup/job-object tests." But the `SandboxProvider` contract requires only that it "terminate the process tree on abort, timeout, server shutdown, or output overflow" — it does not require a primitive that can actually guarantee that (PID namespace, cgroup, or job object). Move the requirement into the provider contract rather than the test list.

### m-5 — `--ignore-rules` is listed as isolation but reduces hardening

Its documented effect is "Do not load user or project execpolicy `.rules` files." That is context isolation, not confinement — it removes the only user-configurable command-restriction layer for a process that (per B-2) retains a shell. Label it accordingly, and see B-2 for the inverted use.

### m-6 — The cited source design still contradicts this architecture

`docs/mcp-integration-design.md` is named by REQ-27 as "the source design" and still shows the superseded contract: `archflow_state (phase, step, status, artifact?)`, `reviews/<phase>.counter.md`, `archflow_waiver (rule_id, rationale)` without scope, and a degraded table that directly contradicts the new manual model — "`archflow_state`: Skip. Status is reconstructable from artifacts on disk" and "`archflow_adjudicate`: Run as an in-session subagent." Phase 13 defers reconciliation to the last phase, leaving two live and contradictory design documents for the whole build. Mark it superseded in Phase 1 instead.

### m-7 — Waiver sequencing under the one-active-gate rule is unstated

"At most one active gate per task," and `archflow_waiver` "Uses the same durable gate mechanism." The natural flow — an adjudication gate opens, and the human's answer is "request a waiver" — cannot proceed without first resolving or cancelling the open gate. Define the ordering, or state that a waiver may nest.

### m-8 — Reconciliation cost is unbounded and unmeasured

"Reconciliation runs before every request, replay, status report, or manual interpretation and compares state references, projection digests, prepared receipts, and snapshot manifests." For a mature task with many phases and retained results (see M-9), that is O(all evidence) on every call, including cheap `archflow_state` step boundaries which the source design describes as "Cheap, called at every step boundary." No performance criterion exists anywhere in the document.

### m-9 — ArchFlow's own tasks and installer are not in the migration plan

This repository's in-flight tasks — including this one — use the layout the new canonical layout supersedes (`architecture.md`, `reviews/<name>-counter-review.md`, flat `phases/phase-N-*.md`). `archflow-upgrade` arrives in Phase 10 and Phase 13 updates the docs, but nothing states whether ArchFlow dogfoods its own upgrade path on itself, or how existing users' in-flight tasks are handled at release. Separately, `install.sh`'s `STALE_SKILLS` mechanism is the only place skill removal is handled and Phase 7 does not mention it, though two skills are being added and six rewritten.

---

## Summary

The requirement coverage, version pins, CLI flag knowledge, and failure-semantics discipline in this document are unusually good, and the prior rounds clearly closed the easy gaps. What remains is concentrated in three places: **risk ordering** (B-1 — the premises that can kill the design are tested last), **one verified infeasibility** (B-2 — Codex reviewer credential confinement, with no contingency for losing half the product), and **an under-specified core protocol** (B-3 — intent/revision/digest composition, which is cheap to fix now and expensive after Phase 2). The majors are mostly places where a strong invariant is asserted without a mechanism (M-5), a scope without a bound (M-1, M-9), or a requirement without a delivery path (M-2, M-4, M-11).

Nothing here suggests the design is wrong in its fundamentals. B-1 and B-2 together do suggest the *plan* should not proceed to Phase 1 in its current order.

---
*Counter-review: 2026-07-26 · Reviewer: Claude Opus 5 (independent read) · Subject: architecture.md as of this commit*
