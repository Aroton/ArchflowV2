# Prompt: redesign counter-review context and rubrics (one plan session)

Copy everything below the line into a fresh planning session.

---

I want to redesign what ArchFlow's dispatched counter-review sees and how it judges, in one planning session. Produce a phased implementation plan; do not write code in this session.

## The problem

The dispatched counter-review (`archflow_counter_review`) runs the opposite-family CLI headless in an **empty temp workspace** — it cannot read the repository at all. What it sees is only the envelope:

- **Document reviews** (PRD, architecture, phase design): the full document bytes — and nothing else. The PRD reviewer never sees the verbatim user ask, so a PRD that misstates the ask reviews as internally consistent. The design reviewer never sees the codebase, so it can only catch self-contradiction, not claims that are wrong about existing code.
- **Implementation reviews**: complete before/after bytes of every changed file plus impl notes — but not the phase design it must judge conformance against, not the interfaces of unchanged code the change calls, and not any evidence that verification actually ran.

The sealing itself is deliberate and must be preserved: the envelope is digest-bound, so the review is a reproducible attestation about exactly those bytes, immune to prompt injection from repo content and to working-tree drift. **The fix is to enrich the envelope, not to open the repo.**

## Design decisions already made (treat as the brief, not open questions)

1. **Sealed-but-richer.** The reviewer stays in an empty workspace with a digest-bound envelope. Accuracy comes from pinning the right context, in priority order under the existing 1 MiB envelope cap (`REVIEW_ENVELOPE_BYTE_CAP`, `src/review/envelopes.ts`).
2. **Both sides of every comparison must be in the envelope.** Reviews are comparisons (PRD↔ask, design↔existing interfaces, impl↔phase design, call↔signature). LLM reviewers confabulate exactly when one side is missing.
3. **"Cannot verify" is a first-class outcome.** Each rubric gains a non-blocking `unverifiable-claims` criterion: claims the envelope cannot confirm or refute become named findings, never guesses. These findings are the feedback loop that tells us what the context contract should grow to include. Unverifiable is non-blocking because it reflects a gap in the *envelope contract*, not a producer defect.
4. **Evidence is assembled mechanically, never author-curated.** Interface excerpts come from what the artifact names (files mentioned, imports resolved); repo maps are generated tree listings of touched areas. Author-curated evidence inherits the author's blind spots.
5. **Verification transcripts over verification claims.** Pinned test output is evidence; "tests pass" in impl notes is an assertion.

## Per-phase context contract (what the envelope must additionally pin)

| Review | Pin beyond today's subject |
|---|---|
| PRD | Verbatim user ask/charter |
| Architecture | Approved PRD · mechanical repo map of touched areas · interface excerpts for every file/module the design names · conventions (CLAUDE.md) |
| Phase design | Approved architecture · same mechanical evidence for the phase's named files · prior phase's impl notes |
| Implementation | Approved phase design · interface excerpts for out-of-change symbols the changed files import · verification transcript · conventions |

## Replacement rubrics (drop-in for today's `RubricV1`)

`RubricV1` (`src/contracts/rubric.ts`) is strict — `{schema_version, kind, mode, criteria[{id,text,blocking}]}` only — so the context contract lives in criteria text and in the envelope, not in new rubric fields. These three rubrics replace the "Stable rubric" sections in `skills/archflow-prd/SKILL.md`, `skills/archflow-design/SKILL.md` + `skills/archflow-phase-design/SKILL.md`, and `skills/archflow-phase-impl/SKILL.md` respectively. They are valid against today's server and can ship before the envelope work.

### PRD

```json
{"schema_version":"1","kind":"artifact","mode":"adversarial","criteria":[{"id":"substantive-correctness","text":"Report a blocking defect only when it requires producer action, and cite the specific artifact statement it contradicts or stated requirement it leaves unmet; citation is necessary but not sufficient. The violation must follow from the artifact's own text or pinned envelope evidence without assuming behavior the artifact does not specify. A sound artifact is expected to yield zero blocking findings; that is successful review, not under-performance.","blocking":true},{"id":"ask-fidelity","text":"Compare the PRD against the pinned verbatim user ask. Every stated user need is addressed or explicitly excluded with rationale, and no requirement contradicts the ask. If the ask is not pinned in the envelope, do not infer it; report the gap under unverifiable-claims.","blocking":true},{"id":"proportionality","text":"Scope, machinery, and success measures are proportionate to the pinned ask. Flag requirements that exist for hypothetical futures, generality the ask does not need, or process the ask does not justify.","blocking":true},{"id":"testable-requirements","text":"Each requirement is specific and observable enough to verify without guessing intent.","blocking":true},{"id":"stated-assumptions","text":"Material assumptions and unresolved human choices are explicit and do not masquerade as requirements.","blocking":true},{"id":"unverifiable-claims","text":"For each claim you cannot verify because the envelope lacks the evidence (the user ask, a referenced document, a constraint), record one non-blocking finding naming the claim and the missing evidence. Never resolve an unverifiable claim as either satisfied or violated.","blocking":false},{"id":"advisory-observations","text":"Use non-blocking findings for completeness suggestions, debatable readings, and observations. Do not inflate them into blockers merely to report them.","blocking":false}]}
```

### Architecture / phase design

```json
{"schema_version":"1","kind":"artifact","mode":"adversarial","criteria":[{"id":"substantive-correctness","text":"Report a blocking defect only when it requires producer action, and cite the artifact statement and the pinned evidence it contradicts. The violation must follow from artifact text or pinned evidence, never from assumed codebase behavior. A sound artifact is expected to yield zero blocking findings.","blocking":true},{"id":"upstream-coverage","text":"Every requirement in the pinned upstream document (PRD for architecture; architecture for phase design) maps to a design element or an explicit exclusion, and no design element serves no upstream requirement.","blocking":true},{"id":"interface-reality","text":"Every claim the design makes about existing code — that a module exists, an interface has a shape, a behavior is already handled — must match the pinned interface excerpts and repo map. A claim contradicted by pinned evidence is blocking; a claim with no pinned evidence goes under unverifiable-claims.","blocking":true},{"id":"evidence-completeness","text":"Using the pinned repo map, identify components directly adjacent to what the design touches that the design neither uses nor addresses. Blocking only when the omission plainly affects a stated design element; otherwise advisory.","blocking":true},{"id":"proportionality","text":"The design is the simplest structure that meets the pinned upstream requirements; flag layers, abstractions, and phases that exist for unstated futures.","blocking":true},{"id":"phase-plan-soundness","text":"Each phase is independently verifiable, ordered by dependency, and scoped so its completion is observable.","blocking":true},{"id":"unverifiable-claims","text":"For each design claim about existing code or context that pinned evidence can neither confirm nor refute, record one non-blocking finding naming the claim and the file or interface whose excerpt is missing. Never resolve such a claim as satisfied or violated.","blocking":false},{"id":"advisory-observations","text":"Use non-blocking findings for completeness suggestions, debatable readings, and observations. Do not inflate them into blockers.","blocking":false}]}
```

### Implementation

```json
{"schema_version":"1","kind":"implementation","mode":"adversarial","criteria":[{"id":"substantive-correctness","text":"Report a blocking defect only when it requires producer action, citing the changed bytes and the pinned phase design statement or evidence it violates. The violation must follow from pinned material, never from assumed behavior of unpinned code. A sound implementation is expected to yield zero blocking findings.","blocking":true},{"id":"design-conformance","text":"Behavior, files, interfaces, and verification conform to the pinned approved phase design, or the change updates parent documents to declare the deviation. If the phase design is not pinned, report under unverifiable-claims rather than inferring intent from the code.","blocking":true},{"id":"interface-fidelity","text":"Every call from changed code into unchanged code matches the pinned interface excerpts in name, shape, and documented contract. A mismatch is blocking; a call whose target has no pinned excerpt goes under unverifiable-claims.","blocking":true},{"id":"verification-evidence","text":"The pinned verification transcript shows the phase design's stated verification actually ran against the changed behavior and passed. Claimed-but-untranscribed verification is an unverifiable claim, not a pass.","blocking":true},{"id":"simplicity","text":"The implementation is the simplest maintainable solution that satisfies the approved phase and operating envelope.","blocking":true},{"id":"duplication","text":"New duplication is either removed or demonstrably clearer than an added abstraction.","blocking":true},{"id":"dead-code","text":"The change leaves no unreachable implementation, unused compatibility path, or speculative extension point.","blocking":true},{"id":"error-handling","text":"Expected boundary failures are handled and tested in proportion to their current risk.","blocking":true},{"id":"unverifiable-claims","text":"For each judgment you cannot make because the envelope lacks the evidence — an uncited callee, an absent phase design, a missing verification transcript — record one non-blocking finding naming exactly what is missing. Never substitute a guess.","blocking":false},{"id":"advisory-observations","text":"Use non-blocking findings for completeness suggestions, debatable readings, and observations. Do not inflate them into blockers.","blocking":false}]}
```

## Where the machinery lives (read these before planning)

- `src/mcp/handlers/counter-review.ts` — handler; builds the envelope input (artifact + rubric + subject).
- `src/state/produce-subject.ts` — `renderProduceReviewMaterial` decides what the reviewer sees (full document, or before/after change bytes).
- `src/review/envelopes.ts` — envelope construction, subject validation, 1 MiB cap.
- `src/review/counter-review.ts` — dispatch orchestration; rubric identity checks (`rubric_digest` binds the skill's literal rubric).
- `src/dispatch/cli.ts` / `workspace.ts` / `process.ts` — headless CLI invocation, empty temp workspace, 5-minute timeout.
- `src/contracts/rubric.ts` — strict `RubricV1`; `src/contracts/schemas/v1/review.schema.json` — reviewer output shape.
- Skills carrying the current stable rubrics: `skills/archflow-prd/SKILL.md`, `skills/archflow-design/SKILL.md`, `skills/archflow-phase-design/SKILL.md`, `skills/archflow-phase-impl/SKILL.md`.

## What I want from this session

A phased plan, sequenced so each phase is independently shippable and testable:

1. **Rubric swap** (skills text only; works against today's server). Include how `rubric_digest` propagation is validated.
2. **Envelope enrichment**, smallest-first: pinning the verbatim user ask for PRD review is the smallest server change with the highest value — likely a new pinned input captured at task creation or PRD produce time. Then upstream-document pinning (phase design into impl review; PRD into architecture review). Then mechanical evidence: repo map, interface excerpts, verification transcript. For each: where the bytes come from, how they stay digest-bound, how the 1 MiB cap is prioritized when evidence is large, and what happens when a pinned input is unavailable (fail closed vs reviewable-with-unverifiable-findings — recommend one).
3. **Feedback loop**: how `unverifiable-claims` findings surface at triage so the context contract grows deliberately.

Constraints: this is an open-source prototype — simplest design that meets the requirement, no speculative generality (see CLAUDE.md engineering priorities). The sealed-envelope trust boundary is non-negotiable. Task isolation and digest-binding rules in CLAUDE.md apply to any new pinned inputs. The human gate's optional interactive counter-review (full repo access, human-elected) already covers deep exploration — do not rebuild it inside the dispatched review.
