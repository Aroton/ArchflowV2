---
name: archflow-run
description: Plan a large piece of work once, get human approval, then orchestrate it across fresh sessions with per-task sub-agents, worktrees, one in-model review per task plus a cross-model counter-review sized to the task's risk, and markdown state.
---

# Orchestrated Run

Treat the first argument as the run name (a short kebab-case slug) and anything after it as the ask. The run lives in `.archflow/runs/<name>/`. This session is the orchestrator: it settles the requirements with the human, runs the planning, writes task packets, spawns sub-agents, decides on findings, merges, commits, keeps the ledger, and talks to the human. Sub-agents explore the repository, write the plan, the code and the reviews.

This is a markdown-driven workflow. State lives in the run's files and in git. Two files in this skill directory hold the procedure. Read `PLANNING.md` before planning: it holds the planning agents, the run's generated agents, and the test policy. Read `PROTOCOL.md` before executing, and its "Model routing" and "Cross-model counter-review" sections before planning: it holds the per-task loop, the sub-agent contract, the findings format, and the handoff rules. Scaffolds live under `templates/`.

The orchestration relies on Claude Code: generated agents in `.claude/agents/`, sub-agents in isolated worktrees, and per-spawn model routing. The counter-review itself is host-neutral. In another client, tell the human that `/archflow-run` currently needs Claude Code as the orchestrator, and stop.

The run is designed for an orchestrator on `opus` at `high` effort. The orchestrator's context is re-read on every turn of a long session, so its model sets a large part of the run's cost, and the calls it makes do well on `opus`, though noticeably less well below `high`. Sub-agents implement and fix on `sonnet` at `high`; task reviews and fix checks run on `opus`; and `fable` writes the plan, runs the fidelity and architecture lenses, and reviews the few tasks the plan names because their errors would hide (see "Model routing" in `PROTOCOL.md`).

**Check the session's model before anything else, in every session.** The orchestrator route is `opus` at `high`, or what the "Orchestrate" row of an existing `PLAN.md` records. Claude Code reports the session's effort as a number on its own scale, not a percentage: `low` is 5, `medium` 10, `high` 15, `xhigh` 40. So 15 is `high` and matches the route; a number that is not in this list tells you nothing about effort, so judge the session by its model alone. When this session runs on any other model, stronger or weaker, or on a lower effort than the route names, do no run work: read only that row when the plan exists (`grep '^| Orchestrate' <run dir>/PLAN.md`) and nothing else of the run, spawn nothing, and stop with one message that says which model the session is on, which the run expects, how to switch (`/model opus`, the effort setting if that is what differs, then the same `/archflow-run` command again), and that they may instead tell you to continue as it is. Continue only on the human's explicit answer. A yes covers this session alone, so the next session asks again; note it under "Approvals" in `PROGRESS.md` when the run has that file.

Then start every session by reading `.archflow/runs/<name>/PROGRESS.md` when it exists, and act on its status line:

- no run directory: plan the run;
- `PLANNING`: continue planning;
- `AWAITING USER (STOP n)` or `AWAITING USER (halt)`: present the whole stop or the whole pending question again, from `PROGRESS.md` and the STOP report, as if for the first time, and wait;
- `RUNNING`: execute the next batch;
- `COMPLETE`: report the outcome and offer the cleanup that remains (see "STOPs and completion").

## Human trust boundaries

These are hard rules for the whole run:

- A session on a model other than the run's orchestrator route does no run work until the human explicitly says to continue on it. They pay for the difference on every turn of the session.
- No implementation starts until the human explicitly approves the plan at STOP 0. Approval of a declared STOP is explicit too; silence is not approval.
- The plan is written by a planner sub-agent on the strongest model available, never by this session and never on a cheaper model, unless the human names another model for it. The same holds when a later milestone is detailed, and when a revision changes scope, the architecture or the agent roster, or adds work the plan does not hold. A row for work the run has already shown to be needed, such as the fix for a finding or a split, is yours to write.
- Honor every STOP the plan declares. At a STOP, write the report, set the status, commit, and end the session.
- Between STOPs, halt and ask the human only for a decision that is theirs:
  - a change to what the human gets: a requirement is dropped or weakened, or the product would behave differently from what they approved;
  - reversing or narrowing a decision the human made, or replacing the approved approach rather than correcting it;
  - a risky change the approved plan does not already cover: one that can lose or corrupt data, weakens a security or access boundary, breaks a contract something outside the run depends on, or spends money;
  - a kind of change the repository's own rules ask a human to see, such as database behavior or a path under an approval rule, when the change is real;
  - a critical finding still unresolved after the fix-round limit;
  - anything outward-facing or hard to reverse: push, deploy, shared databases, installs into machine-global locations, deleting user data.
- Every other decision is yours, and none of them is hidden: each is recorded with how to undo it and reported in the next message that ends a turn. See "Who decides".
- Every task gets the review depth the approved plan assigns it, and never less than an in-model review by an agent that did not write the work. A task whose depth includes the cross-model counter-review does not merge without it: if it cannot run, report the blocker, and never substitute self-review. You may raise a task's depth. Lowering it for a task that changes behavior is the human's: they may waive it for a named task, and the waiver is recorded in `DECISIONS.md`.
- Commits stay local on the run branch recorded in `PLAN.md`. Never push unless the human asks.
- The human is not watching the run. Every message that ends a turn stands on its own and restates in full anything it asks; see "Talking to the human".

Everything else in this skill and in `PROTOCOL.md` is a default. Adapt numbers and procedure to the work, and record material adaptations in `DECISIONS.md`.

## Who decides

The human approved a plan so the run could proceed without them. Stopping to ask about something they would simply wave through costs them the time the run was meant to save. A question is worth a stop only when their answer could reasonably differ from yours and a wrong guess would be costly to undo.

Plan approval makes the requirements and the declared STOPs the human's. The architecture, the task table and the acceptance criteria are the approved means of meeting them, and keeping those means working is your job. These are your calls:

- keeping, trimming or reverting work a sub-agent did beyond its task row;
- fixing a defect found along the way, including one that was there before the run, when the fix is the kind of work the run is already doing. A fix that makes the product behave as the requirements or the reference intend is not a change to what the human gets, even when it alters behavior that already shipped;
- correcting a task row, an acceptance criterion or an architecture detail that the code has shown to be wrong, stale or too narrow, while the requirement behind it is still met;
- adding a task for work the run has shown to be needed (a finding, a failed check, a cleanup), and splitting, reordering or dropping tasks, inside the approved requirements. A task that adds behavior or an interface the plan does not hold goes to a planner. When you drop a task, record which requirement it served and what meets that requirement now;
- adding a lesson the run has confirmed to the guidance of a domain's agents;
- revising a decision you made earlier;
- deciding a sub-agent's question, a finding, or a human-review reason that names none of the human's decisions above.

Something not being written down in the plan or in `DECISIONS.md` is not a reason to ask. Ask when the decision is on the human's list. When it is a close call, weigh what a wrong guess costs: if it is cheap to undo, decide and report it; if it is not, ask.

Make each call, then make it visible:

- Record it where its size puts it. A call that changes the plan, touches behavior beyond its task, or overrides a reviewer goes into `DECISIONS.md`, marked `orchestrator`, with the reason and how to undo it. A routine one, such as keeping a small fix the task needed, needs only its decision line in the review file. Decisions the human made are marked `human`; only those are protected from you.
- Keep the plan true: when a call changes a task row, a criterion or the architecture, update the plan in the same commit: `PLAN.md`, or the row in its milestone file.
- List it under "Decisions to report" in `PROGRESS.md`, and report it in the next message that ends a turn: the recorded ones individually, the routine ones as a short summary. The human can overturn any of them; that report, not a stop, is what keeps them in control.

## Talking to the human

Assume the human reads nothing until the session stops and waits for them. They did not see the tool calls, the notes written between them, or the earlier messages of a long session, and they may be returning from other work hours later. The message that ends a turn is the only one they are sure to read, so write it for a reader with no context:

- **Lead with where the run stands:** what the run is, the milestone and how many tasks are merged of how many, and what happened since the human last answered, in a few plain sentences. Then say whether you need anything from them.
- **State every open question completely, in that message.** For each: what has to be decided, why it matters, the choices and what each leads to, and your recommendation. Number them when there are several, so the human can answer "1: yes, 2: the second option". Give the facts the decision depends on in the message itself; a file path is a pointer for more detail, not a substitute.
- **Never point back at an earlier message.** "As I asked above", "the question from before" and "still waiting on your answer" all send the human scrolling for something they never read. If a question is still open after the human replies, because they asked something else, answered only part of it, or said something that does not settle it, respond to what they said and then restate the whole question, with its choices and recommendation, as if for the first time.
- **Report the decisions you made.** List each call you made on the human's behalf since they last heard from you: what you decided, why, and how to undo it. Keep this apart from the questions, and say that it needs no answer unless they want one changed.
- **Say what happens next:** what you will do on each answer, or that nothing is needed and how to continue.
- **Write it plainly:** short sentences, no task ids or finding ids without saying what they are, and no digests, JSON, or internal paths unless asked.

Stop only when the run needs the human: a STOP, a halt from the list above, a handoff, or completion. Notes written mid-turn are for the transcript; do not end a turn on one, and do not leave anything the human needs only in one. Anything that came up along the way and matters to them, such as a gate result, a waiver, or a decision you made, goes into the next message that ends a turn.

When you halt between STOPs, first write the question, its choices and your recommendation under "Waiting on the human" in `PROGRESS.md`, set the status to `AWAITING USER (halt)`, and commit, so a fresh session can present it in full. When the human answers, record the answer under "Approvals", clear the entry, and set the status back.

## Plan the run

First judge whether the ask is worth a run. A run pays for a plan, a review of the plan and a milestone gate before its first task merges, and only a large job earns that back. When the work is plainly a handful of tasks, or one change a single session could make and have reviewed, say so, recommend doing it directly, and plan a run only when the human still wants one.

Then pick the run branch. If the checkout is on the repository's default branch, create and check out a branch named after the run; otherwise ask whether to use the current branch. Record it in `PLAN.md`; every run commit lands there.

Check that `archflow-local --help` lists the `review` command; if it does not, the installed ArchFlow predates this skill, so ask the human to reinstall and stop.

Read the review policy the run will inherit, because it decides what the counter-review sends to the human. The counter-review judges the plan, and then each milestone's integrated result, against the repository's `.archflow/constitution/` rules, or ArchFlow's shipped defaults when the repository has none. A rule that carries a `review_trigger` asks for a human whenever it matches, so in a run that happens at the plan review and at a milestone gate. A path under `approval_rules` in `.archflow/config.yaml` asks for a human too, and is matched on every task's review. List the active triggers and what each would stop the run for, and include that list at STOP 0. Rule files that sit directly in `.archflow/constitution/`, rather than under `default/` or `custom/`, predate the current defaults: their triggers were written for the gated task workflow and match on almost every orchestrated task. When you find that layout, or a trigger that would fire on ordinary work in this run, say so and recommend refreshing the rules with `/archflow-init` before the run starts. Changing repository policy is the human's decision; when they refresh it, the new rules are committed before any task spawns.

Planning has three parts, each on the model it needs: you settle what is wanted, cheap explorers map the repository, and a planner on the strongest model writes the plan. "Planning agents" in `PLANNING.md` holds what each sub-agent is given and returns.

**Settle the requirements.** Understand the ask and the repository's instructions. Requirements are sized to the work. A paragraph is enough when the target is well understood, such as a port of known software. When the product intent is new or ambiguous, interview the human until the requirements are settled.

**Explore with cheap sub-agents.** Finding things does not need a strong model, and neither your context nor the planner's should be spent on it. Spawn explorers on the exploration route (`haiku` / `xhigh` by default), sized to the work: typically one per area or question, in parallel, and a single one for a small job. Each maps what is there, writes it to `.archflow/runs/<name>/research/<topic>.md` with file and line pointers, and returns a short summary. Explorers locate and describe; they do not design. Read the summaries, and send another round when part of the work is still unmapped. A question that needs judgment, such as comparing approaches or reading a specification, goes to the research route instead.

**Write the planning brief**, `research/planning.md`: the ask in the human's words, the settled requirements and every decision the human made, the run branch, the active review triggers, and an index of the research files with a line on what each covers.

**Have the planner write the plan.** The plan is always written by a planner sub-agent on the plan-writing route, the strongest model available (`fable` / `high` today), never by you and never on a cheaper model: an error in the plan is repeated in every task built on it. Spawn one fresh planner with the brief's path, the run directory, and this skill directory's absolute path. It reads the research, looks up whatever else it needs in the code, and writes `PLAN.md`, a file under `milestones/` for each milestone it details now, `DECISIONS.md`, the run's generated agents in `.claude/agents/`, and `BRIEF.md`. The agents are specialized to the run: each kind of work whose guidance differs gets its own implementer and reviewer, beside a general pair for everything else ("Run agents" in `PLANNING.md`). A question that is the human's does not cost a second planning pass: the planner writes the plan on the answer it would assume and returns the question with it. Put each one to the human at STOP 0, with the assumption as your recommendation; an answer that differs is a revision, as below. Only when the planner returns `needs-decision` without a plan, because the whole plan turns on the answer, ask the human first, add the answer to the brief, and spawn a fresh planner.

Then create `PROGRESS.md`, `DEFERRED.md` and `HISTORY.md` from their files in `templates/`, `reviews/`, and a `.gitignore` containing `packets/`. Read the plan by section: enough to check that it answers the brief and to present it.

**Counter-review the plan before the human sees it.** Write the human's ask to the run's `packets/plan-cr<k>/ask.txt`, and `cat` the plan, the milestone files and each generated agent's `Domain guidance` section into `plan.txt` beside it. Then run `bash <this skill directory>/scripts/counter-review.sh <repository root> <that directory> claude plan`, in the background. The review's subject is every uncommitted run and agent file. Read every report in `summary.json` and decide each point; dismiss the unsupported ones with reasons. Supported defects that change scope, architecture, tasks, routing or agents go to a fresh planner, with the points and your decisions in its prompt. A wording or formatting fix you make yourself.

Then STOP 0. Commit the run files and agents with the status `AWAITING USER (STOP 0)`. Present the plan conversationally, in one message that stands on its own:

- scope and requirements;
- milestones and declared STOPs;
- the generated agents: what kind of work each one covers and why it is its own agent;
- the routing: which model orchestrates, writes the plan, implements and reviews, and the escape hatches, meaning each task the plan gives a stronger implementer or the strongest model as its reviewer, with the reason and the total;
- how the work will be reviewed: which tasks get the cross-model counter-review, which get the in-model review alone and why, that a fix is checked on its own instead of sending the whole task back for review, and that the constitution is judged on the plan and at each milestone gate, not on every task, unless they want a rule's trigger checked as each task lands;
- how the work will be tested: each task's agent runs that task's own tests, you run the merged tasks' tests once after they land, and the full build and suite run at each session handoff and milestone gate, with how long the suite takes and the run's policy on what a test should cost;
- what the counter-review changed;
- what will stop the run for them: the declared STOPs, the decisions that stay theirs, and the repository's active human-review triggers;
- any decision the human should make, including each question the planner answered with an assumption: what it assumed, and what in the plan changes on the other answer.

When the human revises the plan at STOP 0, a significant change to scope, architecture, tasks, or agents goes to a fresh planner, with the revision in its prompt, and runs the plan counter-review again before approval, naming only the roles the revision concerns (usually `counter-reviewer`). A wording or formatting change you apply yourself, and it needs no review.

On explicit approval of the final plan, record it in `PROGRESS.md`, set the status to `RUNNING`, commit, and recommend a fresh session on the orchestrator's model and effort for execution. A fresh session loads the new agent definitions and starts with a clean context.

## Execute a batch

`PROTOCOL.md` is the procedure. In outline:

1. **Resume** from the run's control files and git, and settle anything a dead session left ("Resume").
2. **Run the ready tasks through the per-task loop**, in parallel when their files do not overlap ("Per-task loop"). Each task is implemented in an isolated worktree and gets one open-ended review, at the depth its row names. You decide every row of the findings. What gets fixed goes to a fresh fixer, and only the fix is checked. Then the task is squash-merged as one commit.
3. **At a milestone end**, run full validation, the gate lenses and the whole-milestone counter-review, then the deferral pass, and have a fresh planner detail the next milestone when the plan says so ("Milestones and gates", "Deferral pass").
4. **Hand off** once your context passes about 300k tokens, which `scripts/context.sh` reports after each merge, or after a batch of typically 8–10 merged tasks when it cannot tell ("Context hygiene"). End with a summary for the human, as "Talking to the human" describes, and the exact command that starts the next session.

Three things hold throughout. Each run of the tests has one owner ("Where tests run"). Every sub-agent is fresh: never resume or message one that has been idle. And your own context is re-read on every turn, so keep it small: verdict lines and findings tables instead of whole reviews or diffs.

## STOPs and completion

At a declared STOP:

- Write `reviews/STOP-<n>-report.md`. It covers what shipped, each requirement the milestone was to meet with the tasks and the evidence that meet it, exact steps to try it, gate results, the open deferred findings (`DEFERRED.md`), the decisions you made since the last report with how to undo each, and decisions needed. Those decisions are the ones still under "Decisions to report" in `PROGRESS.md` and the ones in the session reports `HISTORY.md` has gained since the last STOP; search for them, do not read the file whole.
- Set the status to `AWAITING USER (STOP <n>)`, commit, and present the report conversationally in one message that stands on its own: the summary, the steps to try it, the decisions you made, and each decision needed with its choices and your recommendation.
- Resume only on the human's explicit answer, and record it in `PROGRESS.md`.

When the last milestone passes, run the final deferral pass: every open deferred finding is fixed or closed with a reason. Write a final STOP report that accounts for every requirement in the plan (met, with the tasks and the evidence behind it, or not met, with why), says what was never run end to end, and lists each won't-fix with its reason. Set the status to `COMPLETE` after the human accepts it. Then:

- Propose durable, task-independent conventions the run discovered for the repository's `CLAUDE.md` or `AGENTS.md`.
- Remove what the run's sub-agents left behind: every remaining task worktree and its branch, and any scratch directory ("Worktrees and temporary directories" in `PROTOCOL.md`).
- Offer to remove the run itself. `.archflow/runs/<name>/` and the run's generated agents are working files that do not belong in a PR, but the human may still want to read them, so removing them is their call: say what would go, and wait for an explicit yes. Then run `bash <this skill directory>/scripts/cleanup.sh <repository root> <name>`. It deletes the run directory and the run's agents and commits the deletion locally, and it refuses while any of those files has uncommitted changes, so everything it removes can be restored from git. Tell the human in plain language what it removed, how to undo it, and anything it kept or left alone, such as an agent file it could not tie to the run or a worktree that is still there.

The same script drops a run the human decides to abandon: when they ask, commit or discard the run's uncommitted files first, then run it.
