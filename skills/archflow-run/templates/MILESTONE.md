# <Run title> — M<n>: <goal>

Detailed: <date> · Builds on: <the milestones whose merged work this one starts from, or none>

<!-- One file per milestone, written by the planner when the milestone is detailed. It is what the milestone is
     executed from: the orchestrator and the task agents read this file, and from PLAN.md only the sections marked
     `(shared)`. They do not read the plan's architecture or another milestone's file,
     so everything this milestone's tasks need from either is brought in here. Only the planner reads the whole plan. -->

## Design
<Everything this milestone's tasks need in order to be built: the parts of the plan's architecture they depend on
(name the section each comes from), the interfaces earlier milestones merged that they build on, what this milestone
adds, and its code-shape entries. Numbered so rows and packets can cite them (M<n>.1, M<n>.2, …). A decision later
milestones also depend on is recorded in PLAN.md §2 as well.>

## Tasks
| id | goal | files | acceptance tests | depends on | size | agent | review | lane |
|---|---|---|---|---|---|---|---|---|
| M<n>-T1 | <goal> | <paths> | `<test file>`: • <assertion>; • <assertion> | — | S | `<name>-<domain>-implementer` | full | A |
| M<n>-T2 | <goal> | <paths> | `<test file>`: • <the invariant, and the check that proves it> | M<n>-T1 | M | `<name>-<domain>-implementer` `opus/high`: <reason> | full, `fable` review: <reason> | A |
