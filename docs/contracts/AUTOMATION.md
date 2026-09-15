# contracts/AUTOMATION

**Explored:** 2026-09-12 · **Commit:** `1f89243` · **Covers:** `src/contracts/automation-status.ts`, `src/contracts/workflow-progress.ts`, `src/local/automation-status*.ts`, `src/local/commands.ts`, `src/state/semantic-*.ts`, `src/dispatch/recovery.ts`, `test/integration/automation-status-*.test.ts`

For Review V4, `awaiting-client` at triage means the working AI must interpret reports and submit finish, revise, or escalate. It is not itself a human boundary. Partial feedback remains visible during retry, and successful siblings are reused. Completed-round progress remains independent of dispatch retries.

`archflow-local automation-status --task <task>` is the read-only controller contract. It identifies the current condition, responsible actor, and exact next skill or repair action. It never reads stdin, acquires the task lock, dispatches reviewers, edits files, answers gates, stages files, or commits.

The command emits one canonical JSON document using schema version **3** (`urn:archflow:schema:v3:automation-status`, `automation-status-v3.schema.json`). Classified observations exit zero, including blocked and complete states. Invalid arguments or failures that prevent a trustworthy observation return a structured nonzero error. Strict v1/v2 parsers remain available for their historical contracts; consumers must reject unsupported versions, not reinterpret v3 as the old automatic-launch contract.

## Conditions and ownership

| Condition | Responsible actor | Next action | Meaning |
|---|---|---|---|
| `awaiting-client` | skill | `continue-skill` | Start or resume this skill when no producer is alive. Includes automatic review, remediation, recovery, retries, and authenticated commits. |
| `awaiting-human` | human | `respond-in-session` | Present the owning interactive skill's configured approval or real exception. |
| `awaiting-transition` | human | `launch-skill` | The current skill has finished. Wait for the user to launch exactly the returned successor. |
| `blocked` | operator | `repair` | Trustworthy continuation is unavailable. Explain the reason and repair instruction. |
| `complete` | none | `none` | Stop the task loop. `progress.boundary` distinguishes completion from abandonment. |

The complete skill, not an internal pipeline step, is the manual handoff boundary. No extra content approval is needed at that handoff. Only the exact successor invocation receives the semantic `start-next-skill` offer. A controller never calculates the next phase number or starts successor work because a pipeline step merely says `succeeded`.

Every document carries `schema_version`, `task_id`, `observation_id`, `state_revision`, `position`, `condition`, `next_action`, `implementation_recommendation`, and `progress`. Positionless damaged/staged states have `position:null`; a new task has a PRD position and `state_revision:null`. `progress:null` means no readable pipeline position is available.

`progress` exposes:

- `step` and `step_status`: durable pipeline activity, separate from skill completion.
- `review_rounds_completed` and `review_round_limit`: completed review rounds, with a default limit of five.
- `boundary`: `none`, `configured-approval`, `exception`, `step-transition`, `complete`, or `abandoned`.
- `reason`: the human-readable explanation of the next responsibility.
- Optional `dispatch_recovery`: retry status, dispatches consumed, maximum dispatches (three including the initial call), and a scheduled retry time when present.

Progress describes authority; it never supplies an approval token or substitutes for the next semantic action. Human presentations derive from durable gate requests, completed-round counts derive from authenticated retained evidence, handoffs derive from settlement/approval plus Git proof, and dispatch recovery derives from the durable operational journal.

## Controller loop

When several reviewer routes fail, the human boundary's summary and reasons list each unresolved route, its safe cause, and its dispatch count. The primary `failed_role` and `failure_code` still determine the same recovery boundary; the additional explanations do not authorize a substitute reviewer or accept partial output. Semantic status also exposes the other failures in `dispatch_failure.additional_failures`. Details come from the existing durable recovery journal, so losing ignored diagnostics does not erase them.

Keep at most one live producer per task:

```text
poll
 ├─ awaiting-client + producer alive → keep observing
 ├─ awaiting-client + no producer    → resume the returned owning skill
 ├─ awaiting-human                  → present the owning interactive session
 ├─ awaiting-transition             → wait for the user's successor launch
 ├─ blocked                         → surface the exact repair instruction
 └─ complete                        → stop
```

Refetch after producer exit, human response, configuration change, or repository change, and before a user-requested launch. A stale semantic offer causes a fresh status read, not a guessed replay. A transient retry does not permit a second producer while the existing review call is alive.

For example, a completed phase design names `archflow-phase-impl` with `skill_args:["2"]`. The user starts `$archflow-phase-impl <task> 2` in Codex or `/archflow-phase-impl <task> 2` in Claude. The completed design invocation stops; the implementation invocation consumes its own handoff and begins work only after the server authenticates the design authority.

## Configured approvals and exceptions

An `awaiting-human` document carries `human_boundary` with a class, source, headline, summary, question, and structured reasons. It never contains a decision token. Return the user's natural-language answer to the owning skill, which presents and submits the authenticated choice.

A passed compliance review with a matched policy trigger is `configured-approval`, as are configured subject and content matches. Failed or uncertain compliance, uncertain triggers, unavailable authority, and exceptional recovery remain `exception`; any exceptional reason makes the overall boundary exceptional. Multiple same-subject reasons appear together.

The defaults require PRD and overall-design approval, material amendments to their approved decisions, and SQL/database changes. Deterministic path rules cover every changed `.sql` file; constitution review covers embedded queries, ORM behavior, schemas, and migrations. Access-control, public-contract, cryptography/secrets, and workflow-control changes undergo automatic compliance review without category-based human triggers. Custom repository triggers still require a human. Meaning-preserving governing-document maintenance may proceed after independent comparison with the last human-approved bytes. Explicit project content rules still apply, even to a small change.

An SQL approval identifies the matching paths and the owning session explains their frozen operations and byte deltas. A database-behavior approval explains the changed operation, path, and effect through authenticated trigger evidence. When both path and constitution triggers match, the existing combined gate presents them in one decision. Approval authorizes the reviewed subject; it never means a later implementation can borrow an earlier design's approval for different bytes.

## Two separate retry budgets

The server automatically retries positively classified transient reviewer failures twice on the same route. Rate limits, timeouts, recognized temporary transport failures, and unavailable repository views qualify. Missing credentials, invalid/unsupported routes, invalid model output, cancellation, and generic process failures do not. Valid sibling results keep their existing exact-envelope reuse.

The bounded `authority/dispatch-recovery.json` journal records dispatch progress under the task lock with atomic replacement. It is operational state and cannot grant review, approval, commit, or advancement authority. Producer restart or deleted ignored diagnostics cannot reset the budget. Corruption becomes an explicit repair boundary. While recovery says `retrying`, v3 remains `awaiting-client`; exhausted or repair-required failures become `awaiting-human`. An explicit reason-bearing one-dispatch override can authorize a repaired or substitute route; it does not skip review.

Valid reviewer feedback is a separate loop: up to five total completed review rounds by default. Routine production entries and transport retries do not spend rounds. A clean fifth round advances normally; unresolved material findings require human direction before a sixth. Existing pre-history evidence retains conservative legacy accounting, and explicit task `max_attempts` values remain the configured limit. A significant human-directed revision starts its authenticated new cycle.

## Observation identity and recovery

`observation_id` binds the entire public document, canonical state identity, live configuration, and semantic snapshot under the v3 domain. It changes when responsibility, gate reasons, review advice, retry progress, or Git proof changes. It is a deduplication key, never an offer, lease, approval, or mutation token. Repeated identical observations leave files unchanged.

No canonical state and no staged import is a valid new PRD task. Unreadable state or incompatible staged imports produce blocked observations. Recovery categories include `inspect-state`, `resume-exact-intent`, `inspect-retained-receipt`, `create-fresh-intent`, `resolve-current-authority`, `state-unreadable`, legacy-upgrade categories, invalid archived decisions/revision checkpoints/waiver origins, and unavailable presentations or commit facts. Safe existing server recovery actions remain current-skill work; ambiguous receipts, conflicting bytes, destructive restores, and unavailable proof remain explicit repair or human boundaries.

Raw `.archflow` files, offers, gate archives, and decision tokens are not controller APIs. Poll the published command; the owning interactive skill performs authorized mutations. The read path may authenticate current evidence and hash projected files, so polling has a cost. Prefer event-driven reads and short polling intervals appropriate to repository size. The existing benchmark enforces bounded Git calls and cold-process time; it is a regression ceiling, not a performance promise.

## Advice, audit fields, and adoption

`implementation_recommendation`, `validation_overrides`, and `review_push_throughs` retain their v2 meanings. Both audit arrays are copied after action selection and cannot change the selected actor, successor, approval, or commit authority. Ready implementation advice accepts catalog-defined model identifiers and optional effort; never invent omitted effort. Fresh advice includes a `rationale` explaining remaining difficulty, benchmark selection, and any shortfall or fallback. `selection-unavailable` reports unusable selection data or no enabled model above the minimum. Advice is captured at assessment time; config or score edits only affect future assessments. Advice never changes authority or reviewer routing. Validation exceptions never report skipped checks as passed, and review push-through never bypasses configured approvals, policy, or commit proof. Current effort-selector failures retain their advisory fallback and never create a human boundary.

Update controllers to understand v3 before consuming the new CLI. Existing task-local configurations and pinned constitutions are not silently rewritten. To adopt the defaults, explicitly review the repository seed policy and the task's approval rules: keep intentional custom content rules, remove the old blanket parent-document path rule only when adopting the independently reviewed material-plan-change rule, and preserve the SQL rule. Selectively remove the superseded blanket triggers and add the database rule on the repository policy/base branch, preserving custom policy and incrementing changed rule versions. Existing pinned tasks retain their old governing policy; this default update includes no in-flight migration. Adoption never retroactively clears an open gate or changes archived human decisions. Rebuilding the tracked distribution does not authorize a machine-global install.

Uncertain approval triggers are first returned to the producer with the rule and missing evidence named. They use the completed-review-round budget; only a positively matched trigger opens its configured approval immediately. Unresolved uncertainty at the budget limit remains an explicit exception.
