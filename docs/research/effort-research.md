# Effort Review

> Runtime note: this document preserves the research behind the scoring ladder. The shipped selector applies the breakdown privately and returns only one phase-wide model/effort profile. Decomposition and specification observations are scoring inputs, not findings or blockers; selector failure defaults to GPT-5.6 Sol at medium effort without retry.

A new reviewer in the **phase design** counter-review stage, alongside counter / constitution / test.

Its job: assign an implementation **model + effort** per component, so phase impl stops defaulting to Sol max.

Phase design itself always runs at Sol high. That is fixed and not scored.

---

## Adding the reviewer

- **Run it on GLM 5.3 Flash (max thinking).** Rubric scoring against a fixed schema is instruction-following, not open-ended reasoning. GLM's family ranks #6 of 140 on agentic tool use versus #15 of 146 on coding, and that asymmetry is the right shape for a reviewer. Luna xhigh is the fallback. No case for Sol here.
- Inputs: the phase design artifact and the hazard registry.
- Scores each component in the phase separately. If the phase has one undifferentiated component, that is a decomposition failure — return it.
- Nothing changes in PRD or overall design.

---

## Rubric

Score each component 0–3 on five axes.

**A. Derivation depth** — how much search is left for the implementation?
`0` transcription · `1` known pattern needing local adaptation · `2` approach given, mechanism not · `3` no known-good pattern, must derive from constraints

**B. Verifier weakness** — how hard is it to know the code is wrong?
`0` compiler catches it · `1` deterministic unit tests · `2` needs simulation, but reproducible · `3` timing-dependent, nondeterministic, or tail-metric only

**C. State space** — how many interleavings must be reasoned about?
`0` pure or straight-line IO · `1` sequential with error paths · `2` shared state or async, no timers · `3` timers, cancellation, partial failure, cross-component invariants

**D. Specification gaps**
`0` thresholds and priority orderings given as numbers · `1` minor gaps with obvious defaults · `2` a material decision unstated · `3` two or more goals conflict with no priority ordering

**E. Codebase hazard** — from the hazard registry
`0` new module · `1` stable code, clear interfaces · `2` registry module · `3` `unsafe`, `Pin`, hand-rolled lifetimes, or open correctness bug

---

## Reference data

Artificial Analysis Intelligence Index v4.1.1, per effort tier. Tokens and TTFT are what justify the ladder, not the index score.

| Config | Index | Tokens to run index | TTFT | Price in/out |
|---|---|---|---|---|
| Luna xhigh | 50 | 67M | 61.5s | $0.20 / $1.20 |
| Luna max | 52 | 130M | 168.0s | $0.20 / $1.20 |
| Sol medium | **56** | **12M** | **6.9s** | $4.00 / $20.00 |
| Sol high | 57 | 21M | 20.0s | $4.00 / $20.00 |
| Sol xhigh | 59 | — | 52.4s | $4.00 / $20.00 |
| Sol max | 61 | 70M | 120.4s | $4.00 / $20.00 |

Three things fall out.

**Luna max is dead.** +2 index points for 1.9x the tokens and 2.7x the TTFT. Never use it. xhigh is the Luna ceiling.

**Sol max is dead for routine work.** +4 over Sol high for 3.3x the tokens and 6x the TTFT. Your 2h05m run is what a 120s TTFT plus 70M-token-class reasoning looks like inside an iteration loop. The gap is real, so it stays as break-glass, but it should never be a tier anything routes to.

**Sol medium dominates Luna xhigh on capability *and* wall clock.** 56 vs 50 on the index, 12M tokens against 67M, 6.9s TTFT against 61.5s. Sol medium runs the whole index in roughly a third of Luna xhigh's decode time while scoring six points higher. AA notes Sol defines a new Pareto frontier of intelligence versus output tokens per task, and medium is where that shows up hardest.

So the only reason to run Luna xhigh is plan limits. It is not the faster option and it is not the safer option. That is what makes aggressive escalation correct: stepping up to Sol medium buys speed, not just quality.

---

## Mapping: sum → model

GPT is the primary driver. **Max is not a tier.** The bottom of the ladder is a cheap model at its highest thinking setting, never Sol at low.

| Sum | Default | Alternate |
|---|---|---|
| 0–2 | **Luna xhigh** | Gemini 3.7 Flash (max thinking), if B ≤ 1 |
| 3–5 | **Luna xhigh** | GLM 5.3 Flash (max thinking) |
| 6–7 | **Luna xhigh** | GLM 5.3 Flash if E ≥ 2 and A ≤ 1 |
| 8–10 | **Sol medium** | — |
| 11–15 | **Sol high** | — |

Luna xhigh is the spine of 0–7 and should carry the most volume. Gemini and GLM are opt-in plays for speed and limit preservation, not required rungs — when in doubt at 0–7, Luna.

### Fable

Out of the impl ladder. It stays the code reviewer, and it is break-glass for impl only after Sol high fails.

The data supports that. SWE-Bench Pro is the one benchmark where the GPT-5.6 family trails Claude significantly and Fable 5 still leads it, while Sol's advantage concentrates in agentic and computer-use work. Fable's edge is subtle repo-level correctness, which is what a reviewer needs and what a review pass gets in one call instead of a two-hour loop.

**Fable review is mandatory when impl tier ≤ Luna xhigh and B ≥ 2.** Cheap model plus weak verifier is where subtle bugs survive to merge. Everywhere else it is optional, which is the budget lever.

---

## Routing overrides

- **B ≥ 2** → Gemini disqualified. Not deprioritized, disqualified.
- **B ≥ 2 and C = 3** → floor at Sol medium.
- **B = 3 and C = 3** → floor at Sol high. Nothing downstream catches an error here, so the model has to be right by reasoning. This is the liveness-detection shape.
- **A = 0** → cap at Luna xhigh regardless of sum. Transcription needs no search.
- **E ≥ 2 with A ≤ 1** → prefer GLM. Messy repo, written procedure, shallow reasoning is GLM's whole pitch.

Reviewer may move one tier either way with a written reason. More than one means return to author.

### Gemini is one-shot, not iterative

Gemini is bimodal in practice: correct or not, with little useful middle. That is a variance property, and the index hides it completely — Gemini 3.7 Flash scores 56 on the AA Intelligence Index, level with Sol medium. Log evidence beats the index here.

- **Gate on B, not on difficulty.** Bimodal is fine when a wrong answer is caught immediately and cheaply. It is dangerous when nothing catches it.
- **No iteration.** On failure, promote. A retry is the same coin flip.
- **No long agentic loops.** Terminal-Bench 3.0 puts Gemini 3.7 Flash at 14.9 against Terra's 20.8, and its model card lists occasional slowness and timeouts, which erases the speed argument on long runs.

GLM sits above it because it degrades gracefully. Lower ceiling, but it makes progress across iterations and holds to instructions, so it is the right pick for anything that needs to converge rather than land.

### Escalation

Be aggressive. Escalation skips rather than creeps, because Sol medium is faster in wall clock than everything below it.

- Gemini fails → Sol medium. Do not detour through GLM or Luna.
- GLM or Luna xhigh fails → Sol medium.
- Sol medium fails → Sol high.
- Sol high fails → Fable review, or return to phase design. Sol max only if both are exhausted, and log every use.

Never retry the same config. Never push Luna past xhigh.

---

## Blocking rule

**D ≥ 2 on any component: assign no tier, fail the review, emit blocking questions.**

Routing to a better model against an underspecified problem buys a well-argued solution to the wrong problem. A gap a human closes in ten minutes costs hours when an impl run closes it by exhaustion.

Blocking questions must be answerable with a number or an ordering. "Acceptable false-positive reconnect rate per hour?" is usable. "How should we balance battery and responsiveness?" is not.

---

## Hazard registry

Short, hand-maintained. The reviewer cannot see repo history and will underscore axis E without it.

| Module | Hazard | Score |
|---|---|---|
| transport/conn.rs | hand-rolled Pin projection, manual waker | 3 |
| transport/flow.rs | window accounting, off-by-one caused prod bug 2026-04 | 2 |

Add an entry whenever a component takes far longer than expected for reasons specific to the code it touched.

---

## Notes

AA index numbers are a general-intelligence aggregate on Python-heavy evals. Rust async is not represented in any of them. The token and TTFT columns transfer better than the index scores do, because they are properties of the effort setting rather than of the task mix.

Watch the 7/8 boundary first. It is the only place a component crosses from free to limit-consuming, so a band one point too wide there costs more than anything else in the table.

On Rust: the compiler is a strong verifier for safe sequential code, pushing axis B toward 0 and making most components land lower than instinct suggests. It is weak for async timing, cancellation correctness, and cross-task invariants. Let axis B carry that rather than applying a blanket language-level bump.

Axis B overlaps the existing test reviewer, which already forms a view on how detectable a failure is. Consider having test review emit B rather than judging it twice.
