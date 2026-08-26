# contracts/AUTOMATION

**Explored:** 2026-08-26 · **Commit:** `16193ec` · **Covers:** `src/contracts/automation-status.ts`, `src/local/automation-status.ts`, `src/local/commands.ts`, `src/local/main.ts`, `src/state/semantic-status.ts`, `test/integration/automation-status-*.test.ts`

`archflow-local automation-status` is the stable read-only handoff between ArchFlow and an external controller. It answers three questions from one reconciled observation: what condition is the task in, who is responsible now, and which canonical skill—if any—owns the next producer session.

The command observes authority; it never creates it. It does not acquire the task lock, open or answer a gate, consume an offer, dispatch a reviewer, write a cache, stage files, or commit. An interactive skill remains the only client that follows `archflow_status`/`archflow_apply`, presents human decisions conversationally, and executes authenticated commit facts.

## Command and process contract

```bash
archflow-local automation-status --task <task>
```

`automation-status` is task-required, accepts no payload, and never reads stdin—even when its parent leaves stdin open. Each invocation prints exactly one canonical JSON document to stdout. (The `--repository <name>` flag that `restore` accepts for a configured writable secondary is rejected by every other command, including this one; see `../cli/COMMANDS.md`.)

- A classified observation exits `0`, including `blocked` and `complete`.
- Invalid arguments or a repository/preflight/identity failure that prevents a trustworthy classification exit nonzero, print one structured `ok:false` project-error envelope to stdout, and print a concise reason to stderr.
- The successful document is the status object itself, not an `{ok,value}` wrapper.
- The JSON Schema is `src/contracts/schemas/v1/automation-status.schema.json`, identified by `urn:archflow:schema:v1:automation-status`. Consumers should reject unknown fields and unsupported `schema_version` values.

## Document contract

Every successful arm has these fields:

```text
schema_version  "1"
task_id         exact requested task ID
observation_id  SHA-256 identifier for this complete derived observation
state_revision  non-negative durable revision, or null when no readable canonical state exists
condition       awaiting-client | awaiting-human | ready | blocked | complete
position        prd | design | phase-design N | phase-impl N, or null only where authority is unreadable/staged
next_action     exactly one condition-specific discriminated action
```

The closed union permits `human_boundary` only on `awaiting-human`, and `blocked` only on `blocked`.

| Condition | Responsible actor | Action kind | Meaning |
|---|---|---|---|
| `awaiting-client` | `skill` | `continue-skill` | Start or resume the returned owning skill if no producer is already alive. |
| `awaiting-human` | `human` | `respond-in-session` | Put the returned owning skill in front of a human; do not answer on the controller's behalf. |
| `ready` | `orchestrator` | `launch-skill` | Launch exactly the returned successor skill and string arguments. |
| `blocked` | `operator` | `repair` | Stop producer automation and surface the safe instruction and category. |
| `complete` | `none` | `none` | Stop the task loop. |

Skill, human, and orchestrator actions include `skill`, `task_id`, `skill_args`, and a human-readable `instruction`. Owner descriptors are canonical: PRD is `archflow-prd []`, design is `archflow-design []`, phase design N is `archflow-phase-design ["N"]`, and phase implementation N is `archflow-phase-impl ["N"]`. A readable adopted legacy task still at migration audit is owned by `archflow-upgrade`; staged imports are blocked operator states, not invented producer work.

Only semantic `ready` plus the server-returned `start-next-skill` action becomes `ready/orchestrator/launch-skill`. Every other live workflow action—including initialization, production, review, triage, gate-summary preparation, archived-decision settlement, revision, waiver opening, commit execution, recovery, handoff completion, and task finishing—remains current-skill continuation. Controllers must never calculate a phase number or infer a successor from the current position.

### Human boundaries

Every `awaiting-human` arm carries one shape:

```json
{
  "class": "configured-approval",
  "source": "presentation",
  "headline": "SQL changes require approval",
  "summary": "The reviewed implementation changes a configured protected path.",
  "question": "Do you authorize this reviewed result?",
  "reasons": [
    {
      "class": "configured-approval",
      "text": "A configured SQL path rule matched the implementation."
    }
  ]
}
```

`source` is `presentation` for a durable gate and `dispatch-failure` for the current disposable reviewer diagnostic. `class` is `configured-approval` only when every structured reason is an ordinary configured approval; any safety, recovery, unavailable-reviewer, inconclusive-policy, missing-evidence, or exhausted-attempt reason makes it `exception`. The boundary never contains a decision token. Return the human's natural-language response to the owning interactive session; that skill presents the authenticated choices and submits the selected opaque decision.

An exact-current reviewer dispatch failure temporarily takes precedence over the ordinary pending-review projection. It appears as an exceptional human boundary naming the failed role and safe repair-or-substitute conversation. This disposable observation says the last current dispatch failed; it is not durable proof that the outage persists, does not consume a review attempt, and does not authorize fallback. A repaired producer must retry using the same declared invocation route, or obtain the human's reason-bearing one-dispatch substitute through the owning skill.

### Blocked observations

Every `blocked` arm has `blocked.category`, `blocked.reasons`, and an operator `repair` instruction. Stable categories are:

- Semantic inspection: `inspect-state`, `resume-exact-intent`, `inspect-retained-receipt`, `create-fresh-intent`, `resolve-current-authority`.
- Projection-owned recovery: `state-unreadable`, `legacy-upgrade-staged`, `legacy-upgrade-restart-required`, `archived-decision-invalid`, `revision-checkpoint-invalid`, `waiver-origin-invalid`, `presentation-unavailable`, `commit-facts-unavailable`.

Reasons are safe explanatory text. Paths, offers, digests, decision tokens, and mechanical archive identifiers are intentionally absent. A blocked document is a successful observation and exits zero; stop automation and follow only its operator instruction.

## Controller loop

Maintain at most one live producer per task:

```text
poll
 ├─ awaiting-client + producer alive  → keep observing
 ├─ awaiting-client + no producer     → resume returned owning skill
 ├─ awaiting-human                    → present/resume owning interactive session
 ├─ ready                             → refetch, then launch returned successor
 ├─ blocked                           → stop and surface repair instruction
 └─ complete                          → stop
```

Never launch a second producer merely because polling says `awaiting-client` while one is alive. Refetch after producer exit, after a human response, after a config edit, and immediately before a launch. If the resumed skill finds its semantic offer stale, it calls status again and follows the fresh server action; the controller must not replay or reconstruct an internal offer.

The same loop covers a clean task from PRD through completion. With no matching approval rules, clean reviews advance to `ready` descriptors for design, numbered phase design, and numbered phase implementation until terminal `complete`; no human response or inferred phase order is needed. With a matching `**/*.sql` implementation rule, the reviewed implementation instead reports one `awaiting-human` configured boundary. Approval in the owning session authorizes those exact bytes; after the client executes the returned commit facts and status proves the commit, automation exposes the next returned successor.

## Launching producers

Translate the returned canonical skill name into the host's native invocation syntax, preserving `task_id` and every `skill_args` entry exactly:

```text
Claude: /archflow-prd example
Codex:  $archflow-prd example

Claude: /archflow-phase-design example 2
Codex:  $archflow-phase-design example 2

Claude: /archflow-phase-impl example 2
Codex:  $archflow-phase-impl example 2
```

The controller may append invocation-declared reviewer routes after those returned positionals:

```text
Claude: /archflow-phase-impl example 2 --counter-reviewer claude-fable-5:high --adjudicator gpt-5.6-sol:xhigh
Codex:  $archflow-phase-impl example 2 --counter-reviewer claude-fable-5:high --adjudicator gpt-5.6-sol:xhigh
```

A route is `model:effort[@provider]`. Each role is optional independently. A supplied role is normal invocation input and wins over the task's live phase/base configuration for that run; an omitted role falls back to configuration. The selected candidate is validated without falling through on failure. Evidence records whether the actual route came from configuration, the invocation, or a human one-dispatch override. Invocation routing is controller-declared, not authenticated as a human decision, and the producer must repeat it byte-for-byte through retries and significant revisions.

## First observation and damaged authority

- No canonical state and no staged import is a valid new task: `awaiting-client`, PRD position, `state_revision:null`, and `archflow-prd` ownership.
- One authenticated current-format legacy stage is `blocked/legacy-upgrade-staged`; old, ambiguous, or incompatible stages are `blocked/legacy-upgrade-restart-required`.
- Unreadable or noncanonical state is a zero-exit `blocked/state-unreadable` observation with only safe best-effort position context.
- Repository discovery, preflight, or identity failure that prevents those classifications is a structured nonzero command failure.

Malformed output or an unsupported schema version is a controller error: do not guess. Invalid invocation routes and unavailable reviewers stay with the owning producer as exceptional human boundaries. Git mismatch or reconciliation drift never becomes a launch; it projects the current skill's recovery work or a blocked/operator action. A controller should log the safe public status and leave forensic state to the interactive workflow.

## Freshness, identity, and polling cost

`observation_id` hashes a purpose-tagged canonical structure containing the entire ID-less public observation plus the canonical state identity (or classified absence) and live parsed-config identity. It is stable across identical observations and changes when controller-relevant durable state, live configuration, presentation, reconciliation/worktree proof, Git proof, or edge classification changes. It is useful for deduplication and change detection only. It is not an offer, precondition, approval, lease, or mutation token.

Polling is bounded but not free: the readable path opens the repository once, reads the small authority and retained manifests required by semantic status, and may hash projected worktree files because drift affects the answer. It never reads raw review payloads, `ask.md`, or rendered gate UI, and creates no cache. On the reference Linux x64 machine (Node v24.19.0, Intel Core i5-13500T), five cold bundled-process samples against a representative committed task spawned Git 28 times each and took 936.127–976.153 ms (967.246 ms median). The regression test permits at most 64 invariant Git spawns and 5 seconds per sample; those are generous test ceilings, not performance promises for other repositories or machines. Controllers may poll every one to two seconds for small active tasks, but event-driven reads after producer exit, human response, config change, or repository change avoid unnecessary cold Git work.

Tests assert repeated observations leave `.archflow` byte-for-byte unchanged and launch no reviewer. Repeated identical reads return the same ID; durable state, config, gate, worktree reconciliation, and observed commit changes return a new ID.

## Trust boundary and optional MCP equivalent

The public controller interfaces are this versioned document, its JSON Schema, and the skill descriptors it returns. Raw `.archflow` state, gate archives, retained manifests, semantic offers, digests, and decision tokens are internal authority—not controller APIs. Do not read, copy, submit, or calculate them.

An MCP-based controller may expose an equivalent read-only observation, but it must preserve this exact classification, descriptor, freshness, and no-mutation behavior. MCP is optional: controllers need only the local command and published schema.
