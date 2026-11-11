# <Run title> — plan

Run: `<name>` · Branch: `<run branch>` · Planned: <date> · Approved at STOP 0: <date or pending>

## 1. Requirements
<What the human gets, and what is out of scope. Size it to the work: a paragraph for a well-understood target,
an interviewed requirements list for new product intent. These are the human's: the run does not drop, weaken or
change one without asking.>

## 2. Architecture
<The decisions tasks depend on, numbered so packets can cite them (§2.1, §2.2, …). Record each consequential
choice as an ADR in DECISIONS.md and link it here, marked `human` when the human chose it and `orchestrator`
otherwise. The architecture is the approved means of meeting the requirements: the orchestrator corrects a detail
the code shows to be wrong, updates this section, and reports it.>

## 3. Invariants
<Rules every agent and every task follows. Number them; agents and reviews cite them as I1, I2, …>

## 4. Reference and validation
<What the work is compared against (a reference implementation, a spec, an existing system) and how to validate
against it: golden tests, probes, docs to diff. Generated agents carry this, and a short version in `BRIEF.md`
goes to every cross-model counter-review.>

## 5. Commands
| Purpose | Command |
|---|---|
| Agent check (targeted: tests for the changed files, typecheck such as `tsc --noEmit` or `cargo check`, lint; never a whole suite or full build) | `<command taking the changed files>` |
| Full build, full suite and slow test groups (orchestrator only, once per batch) | `<command>` |
| Install dependencies in a fresh worktree | `<command>` |

Sub-agents run only the agent check, so full builds and anything slow belong to the orchestrator's once-per-batch run;
parallel agents each running a full build can overload the machine. Sub-agents run installs and checks through the
skill's `scripts/wait.sh`, which keeps their prompt cache warm when a command is slow. The agent check must leave the
worktree unchanged (no auto-fix, no snapshot writes, outputs gitignored): a reviewer runs it while the counter-review
reads the same worktree, and a changed file fails that review with `SUBJECT_CHANGED`.

## 6. Routing
| Kind of work | Agent (`subagent_type`) | Model / effort |
|---|---|---|
| <plumbing, mechanical, tightly specified> | `<name>-implementer` + `model`/`effort` override | `sonnet` / `medium` |
| <core, correctness-critical, interface-defining> | `<name>-implementer` | `opus` / `high` |
| <subtle and hard to review: name the tasks> | `<name>-implementer` + override | `fable` / `high` |
| Task review of a `full` task; fix verify | `<name>-reviewer` | `opus` / `high` (`fable` for `fable`-routed work) |
| Task review of a `light` task | `<name>-reviewer` + override | `sonnet` / `medium` |
| Counter-review merge | `<name>-reviewer` + override | `sonnet` / `medium` |
| Verify; deferral pass | `<name>-reviewer` + override | `opus` / `high`; `opus` / `medium` |
| Plan review; fidelity and architecture lenses | `<name>-reviewer` + override | `fable` / `high` |
| Fixer | `<name>-fixer` + override | as the task's implementer; `sonnet` / `medium` for small mechanical findings |

Defaults from the protocol's "Model routing"; adjust to this run, and name both model and effort in every row.

## 7. Milestones and STOPs
| Milestone | Goal | Detail | Gate lenses | STOP |
|---|---|---|---|---|
| M1 | <goal> | detailed now | <fidelity, architecture, …> | — |
| M2 | <goal> | detailed at start | <…> | STOP 1: <what the human does> |

## 8. Tasks
Sizes: S ≤ ~200 changed lines, M ≤ ~450, L ≤ ~600 (split before spawning). `Tn` hard dependency, `Tn (soft)` preference.

Review depth: `full` is the default, for any task that changes behavior (source, test logic, schemas, build or CI
configuration, anything under an approval rule or a constitution trigger): in-model review plus the cross-model
counter-review. `light` is for work whose mistakes are cheap and easy to see (documentation, comments, wording,
formatting, regenerated files, a rename the typecheck proves): in-model review only, covered across models by the
milestone counter-review. <Name any kind of task in this run that is `light` for a reason not listed here.>

### M1
| id | goal | files | acceptance tests | depends on | size | agent | review | lane |
|---|---|---|---|---|---|---|---|---|
| M1-T1 | <goal> | <paths> | `<test file>`: • <assertion>; • <assertion> | — | S | <agent> | full | A |

## 9. Risks
<What could invalidate the plan, and how the run will notice early.>
