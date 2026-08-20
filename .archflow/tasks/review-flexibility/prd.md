# PRD — review-flexibility

**Status:** draft for review
**Date:** 2026-08-19

## Problem

ArchFlow's review machinery is inflexible in ways that block its real goal — running the workflow as an automated pipeline with human attention spent only where it is deliberately targeted:

1. **Task config is byte-pinned and cannot change.** The config's exact bytes are digested at task creation and pinned into state and every review envelope; any later edit fails closed with a config-mismatch error whose only remediation is restoring bytes the client does not have. This has caused agent loops and wasted processing, and it prevents legitimate mid-project changes (rerouting reviewers after an outage, adjusting attempt limits). The pinning was meant to guarantee provenance and prevent silent drift, but per-dispatch evidence already records the route that actually ran — the pin adds enforcement cost without adding information.
2. **The per-dispatch reviewer route override is unreachable.** The server fully implements it (validated like a pinned route, recorded on evidence with a human reason, shown at gates), but no semantic-tool submission can carry it, so no skill can ever request it. The config-level per-phase-kind `overrides` section is likewise wired but absent from the shipped template — hand-edit only, undocumented in the skills.
3. **Human gates are built-in constants, not targets.** Every artifact and every phase stops for human approval by default. The intended workflow is the opposite: the machine enforces that each step's counter-review *runs*, and human approval is *triggered* only for subjects the project declares — "review the PRD", "review the architecture", "stop when SQL changes".

## Users

- The project owner (human): sets per-project approval targets, receives the targeted reviews, decides at them.
- AI orchestrator sessions (Claude Code / Codex running the skills): execute the workflow end to end, must see config changes and trigger matches clearly enough to act on them and present them.

## Goals

1. **Config is an ordinary editable input.** Editing task config at any point in a task's life never causes a workflow failure; the next dispatch uses the new values. The system's job shifts from *preventing* change to *reporting* it: when config content differs from what was last seen, the change and what changed (field-level, not byte digests) is surfaced to the orchestrating session in status views and in gate presentations, alongside the existing per-dispatch record of what actually ran.
2. **Route overrides are reachable and guided.** A skill can request a per-dispatch reviewer substitution (with a human-provided reason) through the semantic workflow tools; it is validated, recorded on the evidence, and surfaced wherever that evidence is presented. The config template and skills document the per-phase-kind overrides section.
3. **Human approval is a targeted trigger, not a default.** Counter-review before step completion remains machine-enforced and cannot be skipped by rules. Whether a completed step *additionally* waits for a human decision is determined by per-project rules:
   - **Subject triggers** match workflow subjects (PRD, architecture/design, phase design, phase implementation).
   - **Content triggers** match the files a change touches (e.g. path patterns); when one fires, the workflow stops and presents what matched, where (file paths), and a summary of the change.
   - **Default shipped ruleset:** human review for the PRD and the architecture/design, and human approval when SQL files change. Per-project overridable in either direction.
4. **The git boundary is not a protected gate.** Completed phases may commit on the feature branch without human approval when no rule targets the commit; the owner works on feature branches and squash-merges, and does not want commit-level approval.

## Non-goals

- Semantic content analysis of diffs (matching "what the code does" rather than which files changed). Content triggers match files/paths; that is the whole mechanism.
- Multi-user, remote, or adversarial environments. This is a trusted local single-user tool; nothing here defends against a hostile editor of config or state.
- Preserving byte-pinning backward compatibility for in-flight tasks beyond what `archflow-upgrade` already provides; how old tasks migrate is a design decision.
- Release polish, migration tooling, or generality beyond the declared trigger kinds.

## Requirements

**R1 — Free config editing.** Editing `.archflow/tasks/<task>/config.yaml` (or the repo-level config it derives from) at any point — mid-phase, after reviews, after phase completion — never produces a workflow error attributable to the edit. The next state transaction or dispatch reads and uses the new config. Concretely, config content leaves the *input fingerprint*: the config digest is no longer a component of the fingerprint subject bound to review evidence and open gates, so a config edit cannot surface as a fingerprint mismatch and cannot invalidate already-collected counter-review evidence or an open gate.

**R2 — Change reporting.** When config content differs from the last-seen content, the status view returned to the orchestrating session includes a change notice identifying which fields changed (old → new, field-level), and gate presentations include routing-relevant changes since the previous gate. Change notices are informational: no workflow step is blocked by a config change, existing evidence stays valid, and per-dispatch route provenance remains the durable record of what actually ran under which routing.

**R3 — Route override through the semantic API.** A route-override declaration (role, substitute route `{model, effort, provider?}`, human reason) can be submitted through the workflow's public apply path for a dispatch, receives the same validation as a configured route, is recorded on the review evidence with its reason, and does not alter the input fingerprint of the reviewed subject (existing behavior, now reachable). Skills include guidance for the outage case: when and how to request a substitution and that a human reason is required.

**R4 — Targeted approval gates.** After the constitution amendment in R8 is explicitly approved, no workflow step carries a built-in *approval* gate. The gates this replaces are the per-step approval gates: artifact-approval, design-approval, and (per Goal 4) commit-authorization. After a step's counter-review completes, rule evaluation then decides: proceed autonomously, or wait for an explicit human decision on the presented result. Before that amendment lands, implementations may parse, evaluate, persist, and present rule results but must keep the current explicit human approval and commit boundary active. Counter-review itself always runs before a step completes, regardless of any rule. A human-requested simple revision is a continuation of an already-open human gate: it always returns for approval of the final revised bytes and cannot erase an accepted material finding. The non-approval exception and safety gate kinds survive unchanged and are not subject to triggers: attempts-exhausted, constitution-review, material-drift, constitution-edit, restore-collision, baseline-adoption, and migration-audit. Attempt exhaustion and a failing or uncertain constitution rule still stop for a human even when no trigger matches.

**R5 — Rule kinds and location.** Per-project rules support (a) subject triggers over workflow subjects and (b) content triggers over the file paths a change touches. Rules are declarative, human-authored (the shipped ruleset plus per-project amendments), and evaluated by the machine. Trigger rules live in the per-project repository configuration — the same surface R1/R2 make freely editable with change reporting — not in constitution rule files; the constitution's immutable policy-base pinning is unchanged for its existing rule kinds (a mid-project rule change must not reproduce the lock-in this task removes).

**R6 — Default ruleset.** A fresh project starts with: human review of the PRD, human review of the architecture/design, and human approval when a change touches SQL files. Projects may remove or add rules.

**R7 — Content-trigger presentation.** When a content trigger fires, the workflow stops and the presentation to the human names every matching file path, where each lives, and a concise summary of what changed in each — enough for the human to go read the right files without re-deriving the match themselves.

**R8 — Constitution amendment for this repository.** This change includes amending ArchFlow's own active constitution: `explicit-human-authority` narrows from "every gate and commit is human-approved" to "triggered gates require explicit human decisions; commits are not gated by default", and the commit rule is removed or narrowed to match Goal 4.

**R9 — Documentation.** The maintained caps-named documentation set reflects the new model in the same change: config lifecycle (DURABLE-STATE, LIFECYCLE), gate model (LIFECYCLE, COUNTER-REVIEW), overrides (DISPATCH, COUNTER-REVIEW), and the removed pinning limitation (LIMITATIONS).

## Assumptions

- Route-override authorization needs no dedicated pre-approval gate: the human's reason is relayed by the client, recorded, and surfaced at whatever gate or report next occurs (stated because the clarification was not answered directly; consistent with the targeted-trigger model).
- Per-dispatch route provenance on evidence remains the durable record of what actually ran; change notices supplement it, never replace it.
- The trusted-environment model is stable: no work here needs to defend against adversarial config or state edits.
- SQL content triggers match by file path (e.g. `*.sql`, migration directories); SQL embedded inside non-SQL files is out of scope and documented as a limitation rather than solved.
- The task's own `config.yaml` remains the evaluated surface for that task (copied from the repo-level config at task creation, preserving task isolation); repo-level edits seed new tasks, and mid-task changes — including rule changes — are made on the task copy, where R1/R2 apply.

## Risks

- **Removing fail-closed pinning trades audit guarantee for visibility.** A routing weakening mid-task is no longer machine-blocked; it appears as a reported change and (if a rule targets it) at a gate. Accepted deliberately — the environment is trusted and the enforcement caused more harm than the risk.
- **Content triggers by path can miss or over-match.** Path-pattern matching (e.g. API contracts living in variously-named files) is imprecise; projects tune their own patterns. Risk is bounded by R7's presentation: the human sees exactly what matched and can judge.
- **This is an architectural change to the gate model, not a feature bolt-on.** R4/R5 touch the core of every skill's flow. Scope must be kept honest during design: no speculative trigger languages or rule engines beyond the two declared kinds.
- **Self-application hazard:** implementing this task runs under the current constitution until R8's amendment lands. The implementation plan must sequence the amendment explicitly.

## Observable success criteria

1. A task whose config is edited mid-phase proceeds without error; the next dispatch uses the new routing, and the next status view reports the field-level change.
2. After R8's constitution amendment is approved and autonomous consumption is activated, a phase touching only TypeScript completes end to end (counter-review, implementation, verification) with no approval gate and commits on the feature branch — exception gates such as attempt exhaustion still stop when they apply; a phase touching a `.sql` file stops and presents the matching file paths with change summaries. Before that boundary, both outcomes remain explicitly human-authorized while trigger results are persisted and presented.
3. A fresh project's first PRD and architecture each stop for human review with no project-specific rules added.
4. A reviewer substitution requested through the semantic workflow tools during an outage is accepted, runs under the substitute route, and appears on the review evidence with its human reason.
5. Grepping the maintained docs for config pinning finds the change-reporting model instead of the mismatch error.
6. A config edit made while a gate is open and after counter-review evidence exists invalidates neither: the gate remains resolvable against the same evidence, and the evidence remains current — only a change notice is added.
