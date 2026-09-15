# Model and effort recommendations

Updated 2026-09-15. Fresh policy `implementation-agent-selector-v5` separates remaining implementation difficulty from deterministic subscription-cost selection. Benchmark data comes from the user-supplied Artificial Analysis Terminal-Bench v4.0 chart, retained in `assets/implementation-models.yaml`.

## Remaining reasoning

Reviewed designs should settle architecture and consequential decisions. Following specified steps, copying and validating many files, ordinary wiring, and established patterns are routine work. A small function can still be difficult when it requires novel derivation or unresolved synchronization. Neither file counts nor long verification runs increase difficulty. Credit mechanisms and guarantees that existing APIs already supply.

| Category | Default required score | Default selected model |
|---|---:|---|
| Routine instructions and established patterns | 19% | GLM 5.3 Flash |
| Bounded local reasoning within a settled approach | 30% | GLM 5.3 Flash |
| Hard unresolved algorithms or interacting correctness | 40% | GLM 5.3 max |
| Exceptional derivation or deep interacting reasoning | 50% | GPT-6 Astra high |

These thresholds are calibration choices, not a mathematical interpretation of benchmark scores. A 19% benchmark score is the configured eligibility floor, not a guarantee that every task can be completed. Preserve the chart's exact effort variants and qualifications; GLM Flash has no specified effort, and Fable's scores include fallback.

## Subscription cost preferences

The default cheapest-first priority is Z.ai, Google, GPT, Claude, Muse. This is the user's subscription preference, not an API price table. The server chooses the cheapest enabled cost group meeting the threshold, then the first eligible profile in that group's configured allowlist order. Extra benchmark points alone do not outweigh cost. GLM Flash precedes GLM max in the allowlist, so it handles routine and bounded reasoning; GLM max handles hard work. Disabling GLM makes Gemini useful for routine work. Muse and Claude profiles remain listed but disabled by default.

When nothing reaches the threshold, use the best enabled score above the minimum and explain the shortfall. An empty allowlist or no profile above the minimum produces unavailable advice. On reviewer failure, use bounded reasoning with the captured settings. No fallback implicitly enables a model or chooses an unbenchmarked effort variant.

## Calibration examples

Use these as behavioral calibration inputs for the actual effort reviewer, with expected categories withheld during evaluation:

| Example | Expected category and reason |
|---|---|
| Copy 120 approved design files to specified destinations, verify hashes and validate known schemas | Routine: volume adds work, no unresolved mechanism |
| Perform the same copy for two files | Routine: identical reasoning despite lower file count |
| Wire 40 modules through an existing tested transaction API with fully specified calls | Routine: use existing ownership guarantees |
| Adapt a known parser to specified optional fields and locally choose an existing error helper | Bounded reasoning: local choices in an established approach |
| Implement a 30-line asynchronous cache with unresolved synchronization and eviction interactions | Hard: correctness mechanisms still need reasoning |
| Derive a novel scheduler while preserving cancellation, recovery, and fairness across partial failures | Exceptional: deep interacting derivation |

Unit tests validate deterministic selection and contract boundaries. Scripted integration tests validate dispatch and persistence. Neither proves that a live model classifies real work correctly or measures implementation quality. Recalibrate using actual implementations, outcomes, and review/rework cost; existing notes are sufficient, with no extra telemetry subsystem.

## Authority and persistence

Advice never switches sessions, changes reviewer routes, creates gates, or authorizes implementation. Fresh schema-version-3 evidence captures the assessment, settings, scores, result, and provenance. Config/catalog edits affect future assessments only; archived evidence retains its original meaning. Missing selection data produces unavailable advice and ordinary review continues. See `../review/COUNTER-REVIEW.md` for the maintained system account.
