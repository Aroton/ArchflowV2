# Model selector calibration — 2026-09-11

One live Codex CLI request used `gpt-5.6-luna` at `xhigh` with the exact `EFFORT_SELECTOR_INSTRUCTIONS` for `implementation-agent-selector-v3`. All seven cases matched the expected profiles. This is a small batched rubric calibration, not seven independent end-to-end workflow runs or a capability benchmark.

## Method

The CLI ran with `--ignore-user-config --ephemeral --skip-git-repo-check -s read-only` in a temporary directory. The prompt was provided on stdin, instructed the model not to use tools, and requested one JSON object mapping case names to profile IDs. No tool calls appeared in the returned events. Expected answers were withheld from the model.

The wrapper instruction was: “This is a bounded model-selector calibration, not a coding task. Do not call tools or inspect files. Apply the following exact selector policy independently to each case. Return only one JSON object mapping case names to profile IDs, without Markdown or rationale.” It was followed by the exact selector instructions and these inputs:

| Case | Input |
|---|---|
| trivial | Change a single displayed button label from Save to Save draft. Exact string and location are specified. Stable component; existing deterministic test asserts the label; no state change or tool loop; confidently short. |
| routine | Add a specified optional filter to a sequential list endpoint following its existing pattern. Adapt request parsing, query building, and deterministic integration tests. Defaults and all error behavior are specified. Stable modules, sequential error paths, bounded but not confidently short. |
| complex | Implement a specified shared asynchronous cache in a module with known stale-read hazards. The design supplies the architecture but leaves synchronization details to implement. Reproducible simulation verifies ordering; shared async state without timers. Exact consistency and eviction priorities are specified. This is not a short task. |
| concurrency | Implement cancellation and timeout recovery across a distributed lease holder and its queue. The design fixes the protocol but implementation must reason across timers, partial failure and cross-component invariants. Correctness is visible only in timing-dependent failures; no deterministic test oracle exists. Stable code, but not short. |
| mixed | Two components: (1) the exact trivial button-label update described above; (2) cancellation and timeout recovery across distributed lease holder and queue, with timers, partial failure, cross-component invariants and timing-dependent verification. Select one profile for the whole phase. |
| derivation_floor | Derive a novel pure algorithm from explicit constraints; no known-good implementation pattern exists. It is a new module with no state, exact input/output requirements, and an exhaustive deterministic unit-test oracle. The work is not confidently short. |
| unknown_duration | A small known-pattern change to a stable pure function, exact specification, compiler-checked result shape. No hazards or state. Whether a long tool loop is needed and whether it is short are both unknown. |

## Observed result

```json
{"trivial":"gemini-3-7-flash-high","routine":"gpt-5-6-sol-medium","complex":"gpt-6-astra-low","concurrency":"gpt-6-astra-high","mixed":"gpt-6-astra-high","derivation_floor":"gpt-6-astra-low","unknown_duration":"gpt-5-6-sol-medium"}
```

All values equal the expectations set before dispatch. The CLI reported 13,429 input tokens (8,960 cached), 955 output tokens, and 869 reasoning output tokens. These are observed usage fields, not a measured dollar cost. The temporary harness and output were at `/tmp/archflow-model-calibration.hglvP1`; they are disposable, and this report retains the inputs and observed result.

## Limits

The cases intentionally make their risk characteristics clear. This does not establish accuracy on ambiguous real phase designs, isolate case-order effects, or measure variance across repeated runs. Strict contract and integration tests separately check profile binding, archived evidence, public projection, and failure fallback. The calibration does not establish that Astra low and Sol high have equal task cost or validate the user's aggregate benchmark scores.
