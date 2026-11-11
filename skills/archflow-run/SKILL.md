---
name: archflow-run
description: Plan a large piece of work once, get human approval, then orchestrate it across fresh sessions with per-task sub-agents, worktrees, one in-model review per task plus a cross-model counter-review sized to the task's risk, and markdown state.
---

# Orchestrated Run

Treat the first argument as the run name (a short kebab-case slug) and anything after it as the ask. The run lives in `.archflow/runs/<name>/`. This session is the orchestrator: it settles the requirements with the human, runs the planning, writes task packets, spawns sub-agents, decides on findings, merges, commits, keeps the ledger, and talks to the human. Sub-agents explore the repository, write the plan, the code and the reviews.

This is a markdown-driven workflow. State lives in the run's files and in git. Read `PROTOCOL.md` in this skill directory before planning or executing: it holds the per-task loop, the sub-agent contract, the findings format, and the handoff rules. Scaffolds live under `templates/`.

The orchestration relies on Claude Code: generated agents in `.claude/agents/`, sub-agents in isolated worktrees, and per-spawn model routing. The counter-review itself is host-neutral. In another client, tell the human that `/archflow-run` currently needs Claude Code as the orchestrator, and stop.

The run is designed for an orchestrator on `opus` at `high` effort. The orchestrator's context is re-read on every turn of a long session, so its model sets most of the run's cost, and the calls it makes do well on `opus`, though noticeably less well below `high`. The strongest model is spent where it pays: a planner sub-agent on `fable` writes the plan in one bounded spawn (see "Model routing" in `PROTOCOL.md`). When this session runs on a different model or a lower effort, say so in your first message, with `opus` at `high` as the setting to switch to (`/model opus`), and carry on: it is a note about cost, not a reason to stop.

Start every session by reading `.archflow/runs/<name>/PROGRESS.md` when it exists, and act on its status line:

- no run directory: plan the run;
- `PLANNING`: continue planning;
- `AWAITING USER (STOP n)` or `AWAITING USER (halt)`: present the whole stop or the whole pending question again, from `PROGRESS.md` and the STOP report, as if for the first time, and wait;
- `RUNNING`: execute the next batch;
- `COMPLETE`: report the outcome and offer the cleanup that remains (see "STOPs and completion").

## Human trust boundaries

These are hard rules for the whole run:

- No implementation starts until the human explicitly approves the plan at STOP 0. Approval of a declared STOP is explicit too; silence is not approval.
- The plan is written by a planner sub-agent on the strongest model available, never by this session and never on a cheaper model, unless the human names another model for it. The same holds when a later milestone is detailed and when a revision changes scope, architecture, tasks or the agent roster.
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
- adding, splitting, reordering or dropping tasks inside the approved requirements;
- adding a lesson the run has confirmed to the guidance of a domain's agents;
- revising a decision you made earlier;
- deciding a sub-agent's question, a finding, or a human-review reason that names none of the human's decisions above.

Something not being written down in the plan or in `DECISIONS.md` is not a reason to ask. Ask when the decision is on the human's list. When it is a close call, weigh what a wrong guess costs: if it is cheap to undo, decide and report it; if it is not, ask.

Make each call, then make it visible:

- Record it where its size puts it. A call that changes the plan, touches behavior beyond its task, or overrides a reviewer goes into `DECISIONS.md`, marked `orchestrator`, with the reason and how to undo it. A routine one, such as keeping a small fix the task needed, needs only its decision line in the review file. Decisions the human made are marked `human`; only those are protected from you.
- Keep the plan true: when a call changes a task row, a criterion or the architecture, update `PLAN.md` in the same commit.
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

Pick the run branch first. If the checkout is on the repository's default branch, create and check out a branch named after the run; otherwise ask whether to use the current branch. Record it in `PLAN.md`; every run commit lands there.

Check that `archflow-local --help` lists the `review` command; if it does not, the installed ArchFlow predates this skill, so ask the human to reinstall and stop.

Read the review policy the run will inherit, because it decides what the counter-review sends to the human. Every counter-review judges the work against the repository's `.archflow/constitution/` rules, or ArchFlow's shipped defaults when the repository has none. A rule that carries a `review_trigger` asks for a human whenever it matches, and so does a path under `approval_rules` in `.archflow/config.yaml`. List the active triggers and what each would stop the run for, and include that list at STOP 0. Rule files that sit directly in `.archflow/constitution/`, rather than under `default/` or `custom/`, predate the current defaults: their triggers were written for the gated task workflow and match on almost every orchestrated task. When you find that layout, or a trigger that would fire on ordinary work in this run, say so and recommend refreshing the rules with `/archflow-init` before the run starts. Changing repository policy is the human's decision; when they refresh it, the new rules are committed before any task spawns.

Planning has three parts, each on the model it needs: you settle what is wanted, cheap explorers map the repository, and a planner on the strongest model writes the plan. "Planning agents" in `PROTOCOL.md` holds what each sub-agent is given and returns.

**Settle the requirements.** Understand the ask and the repository's instructions. Requirements are sized to the work. A paragraph is enough when the target is well understood, such as a port of known software. When the product intent is new or ambiguous, interview the human until the requirements are settled.

**Explore with cheap sub-agents.** Finding things does not need a strong model, and neither your context nor the planner's should be spent on it. Spawn explorers on the exploration route (`haiku` / `xhigh` by default), sized to the work: typically one per area or question, in parallel, and a single one for a small job. Each maps what is there, writes it to `.archflow/runs/<name>/research/<topic>.md` with file and line pointers, and returns a short summary. Explorers locate and describe; they do not design. Read the summaries, and send another round when part of the work is still unmapped. A question that needs judgment, such as comparing approaches or reading a specification, goes to the research route instead.

**Write the planning brief**, `research/planning.md`: the ask in the human's words, the settled requirements and every decision the human made, the run branch, the active review triggers, and an index of the research files with a line on what each covers.

**Have the planner write the plan.** The plan is always written by a planner sub-agent on the plan-writing route, the strongest model available (`fable` / `high` today), never by you and never on a cheaper model: an error in the plan is repeated in every task built on it. Spawn one fresh planner with the brief's path, the run directory, and this skill directory's absolute path. It reads the research, looks up whatever else it needs in the code, and writes `PLAN.md`, `DECISIONS.md`, the run's generated agents in `.claude/agents/`, and `BRIEF.md`. The agents are specialized to the run: each kind of work whose guidance differs gets its own implementer and reviewer, beside a general pair for everything else ("Run agents" in `PROTOCOL.md`). When it returns a question that is the human's, ask it, add the answer to the brief, and spawn a fresh planner.

Then create `PROGRESS.md` from `templates/PROGRESS.md`, `reviews/`, and a `.gitignore` containing `packets/`. Read the plan by section: enough to check that it answers the brief and to present it.

**Counter-review the plan before the human sees it.** Write the human's ask to the run's `packets/plan-cr<k>/ask.txt`, and `cat` the plan plus each generated agent's `Domain guidance` section into `plan.txt` beside it. Then run `bash <this skill directory>/scripts/counter-review.sh <repository root> <that directory> claude plan`, in the background. The review's subject is every uncommitted run and agent file. Read every report in `summary.json` and decide each point; dismiss the unsupported ones with reasons. Supported defects that change scope, architecture, tasks, routing or agents go to a fresh planner, with the points and your decisions in its prompt. A wording or formatting fix you make yourself.

Then STOP 0. Commit the run files and agents with the status `AWAITING USER (STOP 0)`. Present the plan conversationally, in one message that stands on its own:

- scope and requirements;
- milestones and declared STOPs;
- the generated agents: what kind of work each one covers and why it is its own agent;
- which model and effort each level of difficulty is routed to, the orchestrator included;
- how the work will be reviewed: which tasks get the cross-model counter-review, which get the in-model review alone and why, and that a fix is checked on its own instead of sending the whole task back for review;
- what the counter-review changed;
- what will stop the run for them: the declared STOPs, the decisions that stay theirs, and the repository's active human-review triggers;
- any decision the human should make.

When the human revises the plan at STOP 0, a significant change to scope, architecture, tasks, or agents goes to a fresh planner, with the revision in its prompt, and runs the plan counter-review again before approval, naming only the roles the revision concerns (usually `counter-reviewer`). A wording or formatting change you apply yourself, and it needs no review.

On explicit approval of the final plan, record it in `PROGRESS.md`, set the status to `RUNNING`, commit, and recommend a fresh session on the orchestrator's model and effort for execution. A fresh session loads the new agent definitions and starts with a clean context.

## Execute a batch

Follow `PROTOCOL.md`:

1. **Resume.**
   - Read only the run's control files: `PLAN.md` by section, `PROGRESS.md` and `DECISIONS.md`.
   - Reconcile the task log with `git log`; git wins.
   - Hand any uncommitted leftovers from a dead session to a reviewer before anything else.
2. **Run tasks through the per-task loop.** Each change gets one open-ended review, and after that only its fixes are checked:
   - packet, then the implementer agent the task's row names, in an isolated worktree;
   - one review: a fresh reviewer for that kind of work and, for a `full` task, your own counter-review of that worktree in parallel, then a fresh merge-mode reviewer that folds the finished counter-review into the findings;
   - your decision on each row. A finding is fixed now, deferred, or dismissed: criticals always get fixed, and anything else gets fixed when leaving it would cost more later. Unplanned work is kept, trimmed or reverted. A human-review reason is decided by you or taken to the human, per "Who decides";
   - a fresh fixer for what gets fixed now (a new spawn of the task's implementer agent in fix mode), then a fresh reviewer that verifies those fixes and nothing else. A fix that cannot be checked against something the fixer did not produce, such as new math or a reworked approach, also gets a cross-model review of the fix alone. The task is not sent back for another full review, and the test and constitution reviewers run once per task;
   - squash-merge, one commit per task.

   Run independent tasks in parallel when their files do not overlap. Sub-agents run only targeted tests and typecheck-level checks; full builds, full suites and slow test groups are yours. A sub-agent that waits on a command does so through `scripts/wait.sh`, which returns about every four minutes so its cache stays warm. Never resume or message a sub-agent that has been idle: its prompt cache is gone after about five minutes, so every fix, check of a fix, or answered question goes to a fresh agent.
3. **At a milestone end:**
   - Run the milestone's declared gate lenses and, by default, the whole-milestone counter-review, which is the cross-model coverage for `light` tasks and verified fixes.
   - Run the deferral pass: re-decide every open deferred finding as fix, carry, or close.
   - If the next milestone is "detailed at start", have a fresh planner write its task rows from what the run has learned, and have them reviewed once before spawning any of them: by the plan-stage counter-review when they add architecture or choices the approved plan does not hold, by a fresh in-model plan review when they only continue it. That review needs no human gate unless the milestone changes the requirements or a decision the human made.
4. **Hand off.**
   - When to stop: after the batch (typically 8–10 merged tasks), or earlier when this session's context grows heavy.
   - What to do: run the full build and suite, remove the worktrees and temporary directories this session's finished work left behind ("Worktrees and temporary directories" in `PROTOCOL.md`), write the session handoff into `PROGRESS.md`, commit, and end with a summary for the human: what this session merged, the build and suite result, each decision you made with how to undo it, anything deferred that they should know, what comes next, and the exact command that starts the next session, on the orchestrator's model and effort.

Keep the orchestrator's context small: it is re-read on every turn. Prefer reviewer verdict lines and findings tables to whole reviews or diffs, and bounded windows or delegation to reading large design or source files whole. Let completion notifications wake you instead of polling.

## STOPs and completion

At a declared STOP:

- Write `reviews/STOP-<n>-report.md`. It covers what shipped, exact steps to try it, gate results, deferred findings, the decisions you made since the last report with how to undo each, and decisions needed.
- Set the status to `AWAITING USER (STOP <n>)`, commit, and present the report conversationally in one message that stands on its own: the summary, the steps to try it, the decisions you made, and each decision needed with its choices and your recommendation.
- Resume only on the human's explicit answer, and record it in `PROGRESS.md`.

When the last milestone passes, run the final deferral pass: every open deferred finding is fixed or closed with a reason. Write a final STOP report that lists each won't-fix with its reason, and set the status to `COMPLETE` after the human accepts it. Then:

- Propose durable, task-independent conventions the run discovered for the repository's `CLAUDE.md` or `AGENTS.md`.
- Remove what the run's sub-agents left behind: every remaining task worktree and its branch, and any scratch directory ("Worktrees and temporary directories" in `PROTOCOL.md`).
- Offer to remove the run itself. `.archflow/runs/<name>/` and the run's generated agents are working files that do not belong in a PR, but the human may still want to read them, so removing them is their call: say what would go, and wait for an explicit yes. Then run `bash <this skill directory>/scripts/cleanup.sh <repository root> <name>`. It deletes the run directory and the run's agents and commits the deletion locally, and it refuses while any of those files has uncommitted changes, so everything it removes can be restored from git. Tell the human in plain language what it removed, how to undo it, and anything it kept or left alone, such as an agent file it could not tie to the run or a worktree that is still there.

The same script drops a run the human decides to abandon: when they ask, commit or discard the run's uncommitted files first, then run it.
