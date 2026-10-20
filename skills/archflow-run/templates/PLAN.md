# <Run title> — plan

Run: `<name>` · Branch: `<run branch>` · Planned: <date> · Approved at STOP 0: <date or pending>

## 1. Requirements
<What the human gets, and what is out of scope. Size it to the work: a paragraph for a well-understood target,
an interviewed requirements list for new product intent.>

## 2. Architecture
<The decisions tasks depend on, numbered so packets can cite them (§2.1, §2.2, …). Record each consequential
choice as an ADR in DECISIONS.md and link it here.>

## 3. Invariants
<Rules every agent and every task follows. Number them; agents and reviews cite them as I1, I2, …>

## 4. Reference and validation
<What the work is compared against (a reference implementation, a spec, an existing system) and how to validate
against it: golden tests, probes, docs to diff. Generated agents carry this, and a short version in `BRIEF.md`
goes to every cross-model counter-review.>

## 5. Commands
| Purpose | Command |
|---|---|
| Agent check (targeted: tests for the changed files, typecheck, lint; never a whole suite) | `<command taking the changed files>` |
| Full suite and slow test groups (orchestrator only, once per batch) | `<command>` |
| Install dependencies in a fresh worktree | `<command>` |

Sub-agents run only the agent check. A sub-agent blocked on a long test command outlives its prompt cache, so
anything slow belongs to the orchestrator's full-suite run. The agent check must leave the worktree unchanged (no
auto-fix, no snapshot writes, outputs gitignored): a reviewer runs it while the counter-review reads the same worktree,
and a changed file fails that review with `SUBJECT_CHANGED`.

## 6. Routing
| Kind of work | Agent (`subagent_type`) | Model / effort |
|---|---|---|
| <core / correctness-critical> | `<name>-implementer` | <strongest> |
| <plumbing> | `<name>-implementer` + `model` override | <cheaper> |
| Task review / fix review | `<name>-reviewer` | <per kind of work reviewed> |
| Fixer | `<name>-fixer` | <cheaper; strongest for correctness-critical findings> |

## 7. Milestones and STOPs
| Milestone | Goal | Detail | Gate lenses | STOP |
|---|---|---|---|---|
| M1 | <goal> | detailed now | <fidelity, architecture, …> | — |
| M2 | <goal> | detailed at start | <…> | STOP 1: <what the human does> |

## 8. Tasks
Sizes: S ≤ ~200 changed lines, M ≤ ~450, L ≤ ~600 (split before spawning). `Tn` hard dependency, `Tn (soft)` preference.

### M1
| id | goal | files | acceptance tests | depends on | size | agent | lane |
|---|---|---|---|---|---|---|---|
| M1-T1 | <goal> | <paths> | `<test file>`: • <assertion>; • <assertion> | — | S | <agent> | A |

## 9. Risks
<What could invalidate the plan, and how the run will notice early.>
