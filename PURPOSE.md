# What ArchFlow is for

This page says what ArchFlow is trying to accomplish and how to tell whether it does. It holds no mechanism: if a
sentence here would name a model, a file, a script or a step, it belongs in a skill or in `docs/`. Read it first when
reviewing or changing a workflow, and judge the change against it.

## The goal

**The best automated code for the least compute.**

- **Code that works.** A run's output does what the human asked, and its claims of "done" are backed by review the
  human does not have to repeat.
- **A codebase that gets better.** Each run leaves the code better organized than it found it, because the next agent
  starts cold, reads in pieces, and copies the shape it finds.
- **A cost that scales.** Several runs should be able to proceed at once on one subscription. Compute is the scarce
  resource, and the strongest model's allowance is the scarcest part of it.

Neither side is traded for the other. Quality is not bought by putting the strongest model on every step, and savings
are not bought by accepting worse code. The cheap path and the good path are made the same path by spending compute
where it catches the most, and by measuring both.

## Who it serves

A person building a larger project, for whom this is the core of how the work gets done: they decide what they want,
start a run, and then test, iterate and release what it produced. They approve a plan and walk away. When they come
back they must be able to trust that:

- nothing began that they had not approved;
- every decision that was theirs was brought to them, in a message that stands on its own;
- every other decision was made, recorded with how to undo it, and reported;
- no review was skipped or replaced by the author checking its own work;
- nothing left their machine: no push, deploy, install or deletion they did not ask for.

These are never traded for cost or speed. Everything else in a workflow is a default that evidence can change.

## What good looks like

A review of a workflow should be able to put a number on each of these. The baseline is the one run measured so far,
a 52-task run over one day on 2026-11-17 and 18; costs are Claude-side, at API list price.

| Measure | What it tells you | Baseline |
|---|---|---|
| Cost per merged task | whether the workflow is affordable at all | about $15.60 ($813 over 52 tasks) |
| Share of spend on the strongest model | whether the scarce allowance goes where only it can help | 46% |
| Share of a week's allowance one run-day uses | how many runs can proceed at once | 55% |
| Spend on writing against spend on reviewing | whether the cheaper side is the one being economized | $350 writing and fixing, $195 reviewing and verifying |
| Serious defects caught before merge | whether the review net works | 32 critical or major, in task reviews |
| Serious defects found later | what the net let through | 4 majors at a milestone gate; after the run, not yet measured |
| Findings acted on | whether reviews report real problems | about 200 of 211 |
| Rows that needed no decision | what review output costs the orchestrator to read | 549 of 760 |
| Structure findings per task, over a run | whether the code is getting better organized | not yet measured |
| Stops for the human that were theirs to make | whether the human's time is respected | not yet measured |

A measure with no baseline is a gap to close, not a reason to ignore it.

## What ArchFlow is not for

- It is not a security sandbox, and it does not make an agent's output safe to run unreviewed.
- It does not decide what should be built. Requirements and the decisions the human kept are theirs.
- It does not prove correctness. It buys confidence in proportion to the risk.
- It does not optimize for speed. A slower run that costs less and merges better code is the better run.
- It is not for small changes. A surgical edit is done directly; a run is for a project large enough that planning
  it once and reviewing every task pays for itself.
- It does not release. A run ends with reviewed code on a local branch. The human's own testing, iteration and
  release come after it.

## Judging a change

Ask of any change to a workflow:

1. **Which measure does it move,** and on what evidence?
2. **What does it cost:** agents spawned, tokens, a stronger model, the human's attention?
3. **Does it touch anything the human must be able to trust?** If so it is the human's decision, not a default.
4. **Is it there because the human needs it, or because a model was weak at something?** The second kind must be
   conditional on the task needing it, because it becomes a ceiling as models improve.
5. **Can the agent it addresses act on it** with what that agent is given?
6. **Does it agree with the text beside it,** and say its piece once?

A change that adds an agent, a reviewer or a stronger model and cannot say what it buys does not go in.
