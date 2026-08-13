# mcp/DISPATCH

**Explored:** 2026-08-13 · **Commit:** `66c4c9b` · **Covers:** `src/dispatch/`, `src/state/workspace-cleanup.ts`

Dispatch is how the server turns "get an independent review" into a real child process running the *other* model family's CLI. It exists so that counter-review and constitution-review evidence is something the producer **cannot author** — the server itself spawns the reviewer, captures its bytes, and binds the output to its provenance. One `archflow_counter_review` call may run two child dispatches sequentially: the rubric reviewer, which gets a read-only repository checkout, and — only when the pinned constitution has active rules — the constitution-review child, which gets a sealed envelope and deliberately no checkout.

## The flow

```mermaid
flowchart LR
    R["routing.ts<br/>pick adapter, family,<br/>model, effort"] --> W["workspace.ts<br/>temp dir, fake HOME,<br/>optional read-only repo view"]
    W --> C["cli.ts<br/>preflight, argv lockdown,<br/>output schema"]
    C --> P["process.ts<br/>spawn, 15 min timeout,<br/>8 MiB output caps"]
    P --> O["cli.ts<br/>extract + classify output,<br/>mint observation"]
    O --> T["coordinator.ts<br/>failure record under ignored<br/>diagnostics/attempts/ (failures only)"]
```

- **`routing.ts`** — pure policy. Given the task config, phase, and role, it picks `{adapter, family, model, effort}`. The config roles stay `producer` / `counter-reviewer` / `adjudicator`: `adjudicator` is now simply the model/effort route for the constitution-review child, and the producer is always the connected MCP host itself (derived from the initialize handshake) — it is never dispatched. Family is inferred from the model name prefix (`claude-*` / `gpt-*`), and the cross-family rule is enforced here for both dispatched routes: a counter-reviewer or constitution reviewer in the producer's own family fails with `FAMILY_MISMATCH`.
- **`workspace.ts`** — builds a disposable sandbox outside the repo: a fake `HOME` containing a symlink to only the one relevant credential file, a 7-name environment allowlist, and (for the rubric counter-review only) a read-only repository view — the constitution-review child gets none.
- **`cli.ts`** — the two adapters (`claude-cli`, `codex-cli`): version/auth preflight with minimum CLI versions, a hard-coded lockdown argv (read-only tools, no slash commands, no session persistence, no user config), output-schema projection into each host's dialect, output extraction, and failure classification.
- **`process.ts`** — one child run: detached spawn, piped stdio, 15-minute timeout, 8 MiB per-channel cap, SIGTERM→SIGKILL escalation.
- **`coordinator.ts`** — assembles one attempt end to end and always disposes the process workspace. Telemetry is **failure-only**: a failed dispatch (timeout, cancellation, nonzero exit, bad output) writes a JSON forensic record under ignored `.archflow/runtime/tasks/<task>/diagnostics/attempts/` with stdout/stderr tails and the preflight's managed-policy observations; a successful dispatch writes nothing there. Attempts are current-phase diagnostics and cleanup removes them when the phase advances.

## The read-only repository view

The reviewer gets a checkout of the repository at one pinned commit — HEAD for document reviews, the artifact's attested `base_commit` for implementation reviews (so the reviewer sees the *pre-change* tree; the changes travel only in the envelope).

The checkout is a `git archive | tar -x` extraction, deliberately **not** a worktree: the extracted tree has no `.git` link, so the reviewer cannot reach the producer's tracked triage or pipeline material, and `.archflow/tasks` is deleted from the view. Reviewer independence holds structurally, not by convention.

## What is and isn't guaranteed

State this plainly, because the init skill forbids overclaiming it: **dispatch context hygiene is best-effort, not an enforced isolation boundary.** Nothing filesystem-level prevents the child from reading outside its view; the guarantee is that the real repository path is never disclosed to it, credentials other than its own are not present, and its inputs are exactly the sealed envelope plus the pinned view.

Other properties worth knowing:

- **Dispatches are serialized process-wide** — one child at a time, via a module-level promise queue. This avoids concurrent use of shared credential stores, at the cost of throughput and with no cancellation or fairness.
- **A `fail` verdict is a successful tool result.** The dispatch machinery records what the reviewer said; it never converts a bad review into an error or manufactures advancement.
- **Mid-dispatch drift is caught.** After the child returns, the server re-checks the artifact's digest and aborts with `counter-review-subject-not-current` if the subject changed while the review ran.
- **Reviews can legitimately take up to fifteen minutes** — the child is doing a real exploration of the pinned checkout.

## Fragility to watch

Two parts of this subsystem are version-coupled to the external CLIs and will drift over time: the lockdown argv (flag sets written out literally per CLI release) and the failure classifier, which parses free-text CLI error messages with regexes to detect rate limits and extract model names. When a host CLI updates, look here first.

A third part is coupled to the *providers* behind those CLIs, and has already drifted once: the output-schema projection. It binds each server-derived subject field into the child's schema so a child cannot return a result bound to a different task or digest, and the accepted way to write that binding is not stable. Codex rejects an array-valued `const` outright, so array bindings (only `approved_upstream_digests` today) go to it as exact cardinality plus a closed element set instead; Claude still takes the plain `const`. A provider that tightens its structured-output validator surfaces as an unclassified `PROCESS_FAILED`, and only the opt-in real-host suite (`ARCHFLOW_REAL_HOSTS=1 npm run test:real-host`) can catch it — the local schema compiler accepts far more than the providers do.

The adjudication transport schema asks the child only for bound identity fields plus `rule_findings` and `drift_findings`. Constitution, drift, and trigger rollups are mechanical duplicates, so the server derives them after strict parsing and before minting the unchanged complete evidence shape. This prevents a structured-output host from satisfying the transport schema while contradicting its own findings. Normative parsing and attestation remain the authority: `observeAdjudication` compares every bound field, hashes the exact reduced child bytes, and returns no evidence unless all finding and coverage invariants hold.
