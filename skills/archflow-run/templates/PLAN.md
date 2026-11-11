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
against it: golden tests, probes, docs to diff. When the run has several domains, give each its own reference and
validation. Generated agents carry this, and a short version in `BRIEF.md` goes to every cross-model counter-review.>

## 5. Commands
| Purpose | Command |
|---|---|
| Agent check (targeted: tests for the changed files, typecheck such as `tsc --noEmit` or `cargo check`, lint; never a whole suite or full build) | `<command taking the changed files>` |
| Full build, full suite and slow test groups (orchestrator only, once per batch) | `<command>` |
| Install dependencies in a fresh worktree | `<command>` |

<Add an agent check row per domain when a domain validates its work differently.> Sub-agents run only the agent check, so full builds and anything slow belong to the orchestrator's once-per-batch run;
parallel agents each running a full build can overload the machine. Sub-agents run installs and checks through the
skill's `scripts/wait.sh`, which keeps their prompt cache warm when a command is slow. The agent check must leave the
worktree unchanged (no auto-fix, no snapshot writes, outputs gitignored): a reviewer runs it while the counter-review
reads the same worktree, and a changed file fails that review with `SUBJECT_CHANGED`.

## 6. Agents and routing
The agent follows the kind of work; the model and effort follow how hard the task is.

### Agents
| Agent (`subagent_type`) | Covers | Why it is its own agent | Default model / effort |
|---|---|---|---|
| `<name>-<domain>-implementer` | <the domain and its paths> | <what its guidance holds that the rest of the run does not: its reference, how it is validated, how it goes wrong> | `opus` / `high` |
| `<name>-<domain>-reviewer` | task-review, merge, fix-verify and verify for that domain's tasks | <the lenses that work is reviewed through> | `opus` / `high` |
| `<name>-implementer` | tasks outside every domain | general; the packet carries what a task needs | `sonnet` / `medium` |
| `<name>-reviewer` | reviews of those tasks; deferral, plan review, gate lenses | general | `opus` / `high` |

<One implementer and reviewer pair per domain, sized by the protocol's "Run agents". When the whole run is one kind of
work, keep only the general pair and give it that guidance.>

### Model and effort
| Work | Agent | Model / effort |
|---|---|---|
| Orchestrate | this session | `opus` / `high` |
| Explore during planning | general-purpose + override | `haiku` / `xhigh` |
| Write the plan; detail a later milestone; a significant plan revision | general-purpose + override | `fable` / `high` (always the strongest model) |
| Implement: <plumbing, mechanical, tightly specified> | the task's implementer agent + override | `sonnet` / `medium` |
| Implement: <core, correctness-critical, interface-defining> | the task's implementer agent | `opus` / `high` |
| Implement: <subtle and hard to review: name the tasks> | the task's implementer agent + override | `fable` / `high` |
| Fix | the task's implementer agent, fix mode + override | as the task was implemented; `sonnet` / `medium` for small mechanical findings |
| Task review of a `full` task; fix verify | the domain's reviewer | `opus` / `high` (`fable` for `fable`-routed work) |
| Task review of a `light` task | the domain's reviewer + override | `sonnet` / `medium` |
| Counter-review merge | the domain's reviewer + override | `sonnet` / `medium` |
| Verify | the domain's reviewer + override | `opus` / `high` |
| Deferral pass | `<name>-reviewer` + override | `opus` / `high` |
| Plan review; fidelity and architecture lenses | `<name>-reviewer` + override | `fable` / `high` |

Defaults from the protocol's "Model routing"; adjust to this run, and name both model and effort in every row. The
task table's `agent` column names the implementer agent, with `model/effort` when a task departs from its default.

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
| M1-T1 | <goal> | <paths> | `<test file>`: • <assertion>; • <assertion> | — | S | `<name>-<domain>-implementer` | full | A |

## 9. Risks
<What could invalidate the plan, and how the run will notice early.>
