# Model and effort recommendations

Updated 2026-09-11. This is the rationale for fresh selector policy `implementation-agent-selector-v3`; older research and archived evidence do not define current recommendations.

## Implementation ladder

Architecture and phase design should use **GPT-6 Astra high**. This is advice for the producing session, not a server-enforced model switch. Implementation selection scores what remains to be done after that design.

| Component assessment | Model and effort |
|---|---|
| Total 0–2, every axis ≤1, confidently short, confidently no long tool loop | Gemini 3.7 Flash high |
| Total 0–7 otherwise | GPT-5.6 Sol medium |
| Total 8–11 | GPT-6 Astra low |
| Total 12–15 | GPT-6 Astra high |

A, C, or E equal to 3 imposes an Astra-low floor. B and C both equal to 3 imposes an Astra-high floor. Apply floors before selecting the highest-ranked component profile for the phase. Unknown short-task or loop suitability excludes Gemini.

The fresh profiles are `gemini-3-7-flash-high`, `gpt-5-6-sol-medium`, `gpt-6-astra-low`, and `gpt-6-astra-high`, in that order. The Gemini profile uses the existing Antigravity route `gemini-3.7-flash-high` with effort `high`. GLM is no longer a fresh implementation tier. Sol high/xhigh and Astra medium/xhigh are omitted from automatic selection. **Never recommend or dispatch Astra max.** Explicit Astra-max reviewer routes are rejected before launch; they are not silently downgraded.

## Private rubric

Score each inferred implementation component 0–3:

- **A — Derivation depth:** transcription; known pattern with local adaptation; approach given but mechanism unresolved; mechanism must be derived from constraints.
- **B — Verifier weakness:** compiler catches errors; deterministic unit tests; reproducible simulation; timing-dependent, nondeterministic, or tail-metric verification.
- **C — State space:** pure or straight-line IO; sequential error paths; shared state or async without timers; timers, cancellation, partial failure, or cross-component invariants.
- **D — Specification uncertainty:** specified thresholds and priorities; minor gaps with obvious defaults; material decision unstated; conflicting goals without priorities.
- **E — Codebase hazard:** new module; stable interfaces; known hazardous module; unsafe mechanisms or an open correctness bug. Use the supplied repository hazard registry as context.

The selector privately infers components and includes D in the total. It returns only one bound profile ID. There is no required component manifest, public scoring worksheet, or effort-review blocker. Ordinary review still owns material specification findings and workflow authority. Any selector failure produces Sol medium without a retry or human boundary.

## Quality, cost, and evidence

The user's calibration places Sol high around 52 and Astra low around 54, with little benefit from Astra medium over low and a small task-cost premium at that cutover. These are **user-supplied observations**, not independently verified benchmark measurements. They support skipping Sol high in favor of Astra low, but do not establish universal equivalence.

Official standard API prices are $4 input / $20 output per million tokens for Sol and $10 / $50 for Astra: Astra is 2.5× per token. OpenAI reports that Astra uses substantially fewer output tokens on some evaluations. Total task cost therefore depends on input, cache use, reasoning/output volume, and retries; a small premium is plausible but not guaranteed. For illustration, at equal uncached input I and output O, cost scales 2.5×; lower reasoning volume must offset that premium. Sol's documented promotional pricing lasts at least through November 21, 2026. Recheck pricing when recalibrating.

Sources inspected for this update:

- [Sol specifications and pricing](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [Astra specifications and pricing](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [Astra task-efficiency guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [Fable 5.1 model ID](https://platform.claude.com/docs/en/models/overview)

The earlier unsourced index table is not carried forward as current evidence. Aggregate benchmarks are workload-dependent; they do not prove Gemini unsuitable for all work or turn these scoring thresholds into measured accuracy boundaries. Its implementation role here is deliberately narrow: a short task with cheap, reliable verification. A failed Gemini implementation should be reconsidered at Sol medium or above; this is human-facing guidance, not a new automatic retry system.

## Reviewer roles

Implementation advice and reviewer routing are separate decisions:

| Role | Shipped default |
|---|---|
| Effort selector | Luna xhigh |
| Test reviewer | Luna xhigh |
| Constitution adjudicator | Gemini 3.7 Flash high |
| Counter-review for Claude producers / fallback | Sol medium |
| Counter-review for Codex producers | Fable 5.1 medium |
| Counter-review for Antigravity producers | Sol medium and Fable 5.1 medium |

Luna and Gemini remain for these bounded, inexpensive review assignments, as explicitly requested. This update changes existing shipped Fable routes to `claude-fable-5-1`, preserving effort and family assignments. It does not rewrite explicit repository or task configuration.

## Compatibility and calibration

The payload shape remains version 2, while the fresh policy identity becomes `implementation-agent-selector-v3`. Archived V1 assessments and V2-policy selections retain their original profiles and interpretation. Reading them neither reruns completed reviews nor upgrades their advice.

Strict validation proves profile membership and subject bindings, not the correctness of hidden model judgments. Calibrate with representative trivial, routine, complex, concurrency-heavy, and mixed-component phase designs. Record actual outputs and mismatches; do not mistake scripted test outputs for live model evidence. No new benchmark framework or machine-global installation is required.
