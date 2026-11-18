# <Run title> — plan

Run: `<name>` · Branch: `<run branch>` · Planned: <date> · Approved at STOP 0: <date or pending>

<!-- A section whose heading ends in `(shared)` is read by the agents that execute the run. They select those sections
     by that mark and read nothing else of this file:
       awk '/^## /{shared = / \(shared\)$/} shared' PLAN.md
     Keep the mark on these headings, and keep every `## ` heading on one line. The unmarked sections are the
     planner's: what an executing agent needs from them is carried in each milestone's file. -->

## 1. Requirements (shared)
<What the human gets, and what is out of scope. Size it to the work: a paragraph for a well-understood target,
an interviewed requirements list for new product intent. These are the human's: the run does not drop, weaken or
change one without asking. Number them (R1, R2, …): each gate and STOP report accounts for them one by one.>

## 2. Architecture
<The decisions the run depends on, numbered (§2.1, §2.2, …). The planner reads this section; the agents that
execute a milestone do not, so each milestone's file carries, under "Design", what its tasks need from here. Record
each consequential
choice as an ADR in DECISIONS.md and link it here, marked `human` when the human chose it and `orchestrator`
otherwise. The architecture is the approved means of meeting the requirements: the orchestrator corrects a detail
the code shows to be wrong, updates this section, and reports it.>

**Code shape.** <Where the run's new code goes: the units it adds and the one job of each, the existing units it
extends, and the existing patterns it follows. Name any pattern in the touched code that new work must not copy, and
what to do instead. A line per unit is enough. Packets carry the entries for a task's files, and the structure review
and the architecture lens judge against them.>

## 3. Invariants (shared)
<Rules every agent and every task follows. Number them; agents and reviews cite them as I1, I2, …>

## 4. Reference and validation
<What the work is compared against (a reference implementation, a spec, an existing system) and how to validate
against it: golden tests, probes, docs to diff. When the run has several domains, give each its own reference and
validation. Generated agents carry this, and a short version in `BRIEF.md` goes to every cross-model counter-review.>

**Test policy.** <What a test in this run should cost as well as cover, from "What tests to write" in the skill's `PLANNING.md`:
the layer each kind of behavior is tested at, which boundaries get a real integration test and how few, what makes a
test slow here and which group slow tests join, and how long the full suite takes today. Agents and `BRIEF.md` carry
it too.>

## 5. Commands (shared)
| Purpose | Command |
|---|---|
| Task check (implementers and fixers): the task's own test files, by name, plus typecheck such as `tsc --noEmit` or `cargo check`, and lint; never tests selected by what imports the changed files, a whole suite or a full build | `<command taking test files>` |
| Merge check (orchestrator, once after the tasks in flight together are merged): the task check over those tasks' test files | `<the same command>` |
| Full validation (orchestrator, at the session handoff and the milestone gate): full build, full suite and slow test groups. Takes <duration> today | `<command>` |
| Install dependencies in a fresh worktree: the cheapest setup that is correct, such as an offline or cached install | `<command>` |

<Add a task check row per domain when a domain validates its work differently.> Each run of the tests has one owner
(the protocol's "Where tests run"): implementers and fixers run the task check, reviewers read the result instead of
repeating it, and the orchestrator runs the merge check and full validation. Every one of these goes through the
skill's `scripts/wait.sh`, which keeps a waiting agent's prompt cache warm and lets only a few commands run at once
across all worktrees, so parallel tasks cannot overload the machine.

## 6. Agents and routing (shared)
The agent follows the kind of work. The model follows the run's routing: implementers write on the cheaper model, reviewers judge on the stronger one, and a task leaves that only through a hatch named below.

### Agents
| Agent (`subagent_type`) | Covers | Why it is its own agent | Default model / effort |
|---|---|---|---|
| `<name>-<domain>-implementer` | <the domain and its paths> | <what its guidance holds that the rest of the run does not: its reference, how it is validated, how it goes wrong> | `sonnet` / `high` |
| `<name>-<domain>-reviewer` | task-review, merge, fix-verify and verify for that domain's tasks | <the lenses that work is reviewed through> | `opus` / `high` |
| `<name>-implementer` | tasks outside every domain | general; the packet carries what a task needs | `sonnet` / `high` |
| `<name>-reviewer` | reviews of those tasks; deferral, gate lenses | general | `opus` / `high` |

<One implementer and reviewer pair per domain, sized by "Run agents" in the skill's `PLANNING.md`. When the whole run is one kind of
work, keep only the general pair and give it that guidance.>

### Model and effort
| Work | Agent | Model / effort |
|---|---|---|
| Orchestrate | this session | `opus` / `high` |
| Explore during planning | general-purpose + override | `haiku` / `xhigh` |
| Write the plan; detail a later milestone; a significant plan revision | general-purpose + override | `fable` / `high` (always the strongest model) |
| Implement; fix | the task's implementer agent | `sonnet` / `high` |
| Task review, `full` or `light`; fix verify; verify | the domain's reviewer | `opus` / `high` |
| Counter-review merge; check of a purely mechanical fix | the domain's reviewer + override | `sonnet` / `medium` |
| Deferral pass | `<name>-reviewer` | `opus` / `high` |
| Fidelity and architecture lenses | `<name>-reviewer` + override | `fable` / `high` |
| Dogfood and runtime lenses | `<name>-reviewer` | `opus` / `high` |

Defaults from the protocol's "Model routing"; adjust to this run, and name both model and effort in every row.

### Escape hatches
Tasks that leave those defaults (see "Escape hatches" in the protocol). Each hatch's reason is on its task row: an
`opus/high` implementer for a task that is hard to write, a `fable` review for one whose errors would hide. At run time
the orchestrator opens others on what a review shows, and reports them at each handoff.

<Total: n `opus` implementers, n `fable` reviews, of n tasks. "None" is a good answer when the rows carry their own
checks.>

## 7. Milestones and STOPs (shared)
| Milestone | Goal | Detail | Gate lenses | STOP |
|---|---|---|---|---|
| M1 | <goal> | detailed now: `milestones/M1.md` | <fidelity, architecture, …> | — |
| M2 | <goal> | detailed at start | <…> | STOP 1: <what the human does> |

<A milestone is one complete set of work that is designed together: what must be built and seen working before the
rest can be designed well. See "What a milestone is" in the skill's `PLANNING.md`. The plan chooses each gate's lenses,
except that the last milestone always runs fidelity, over every requirement in §1, and runtime.>

## 8. Tasks (shared)
Sizes: S ≤ ~200 changed lines, M ≤ ~450, L ≤ ~600 (split before spawning). `Tn` hard dependency, `Tn (soft)` preference.

Review depth: `full` is the default, for any task that changes behavior (source, test logic, schemas, build or CI
configuration, anything under an approval rule or a constitution trigger): in-model review plus the cross-model
counter-review. `light` is for work whose mistakes are cheap and easy to see (documentation, comments, wording,
formatting, regenerated files, a rename the typecheck proves): in-model review only, covered across models by the
milestone counter-review. <Name any kind of task in this run that is `light` for a reason not listed here.>

The constitution is judged on the plan and at each milestone gate, not on every task. <Name any rule whose trigger
the human asked to have checked as each task lands.>

The task rows are not in this file. Each milestone's rows, and the design only that milestone needs, are in
`milestones/M<n>.md`, written from `templates/MILESTONE.md` when the milestone is detailed.

## 9. Risks (shared)
<What could invalidate the plan, and how the run will notice early.>
