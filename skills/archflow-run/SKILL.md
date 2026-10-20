---
name: archflow-run
description: Plan a large piece of work once, get human approval, then orchestrate it across fresh sessions with per-task sub-agents, worktrees, in-model review plus cross-model counter-review, and markdown state instead of MCP workflow state.
---

# Orchestrated Run

Treat the first argument as the run name (a short kebab-case slug) and anything after it as the ask. The run lives in `.archflow/runs/<name>/`. This session is the orchestrator: it plans, writes task packets, spawns sub-agents, decides on findings, merges, commits, keeps the ledger, and talks to the human. Sub-agents write the code and the reviews.

This is a markdown-driven workflow. State lives in the run's files and in git, not in a server: do not call `archflow_status` or `archflow_apply`, and do not create `.archflow/tasks/` state. It is not a bypass for an initialized ArchFlow task; work that already belongs to one continues there. Read `PROTOCOL.md` in this skill directory before planning or executing: it holds the per-task loop, the sub-agent contract, the findings format, and the handoff rules. Scaffolds live under `templates/`.

The orchestration relies on Claude Code: generated agents in `.claude/agents/`, sub-agents in isolated worktrees, and per-spawn model routing. The counter-review itself is host-neutral. In another client, tell the human that `/archflow-run` currently needs Claude Code as the orchestrator, and stop.

Start every session by reading `.archflow/runs/<name>/PROGRESS.md` when it exists, and act on its status line:

- no run directory: plan the run;
- `PLANNING`: continue planning;
- `AWAITING USER (STOP n)`: present the stop and wait;
- `RUNNING`: execute the next batch;
- `COMPLETE`: report the outcome and the cleanup that remains.

## Human trust boundaries

These are hard rules for the whole run:

- No implementation starts until the human explicitly approves the plan at STOP 0. Approval of a declared STOP is explicit too; silence is not approval.
- Honor every STOP the plan declares. At a STOP, write the report, set the status, commit, and end the session.
- Between STOPs, halt and ask the human only for:
  - a critical finding still unresolved after the fix-round limit;
  - a change to the run's requirements scope or to an accepted decision in `DECISIONS.md`;
  - a constitution `human_review_reasons` entry;
  - anything outward-facing or hard to reverse: push, deploy, shared databases, installs into machine-global locations, deleting user data.
- Every task gets the cross-model counter-review. If it cannot run, report the blocker and do not merge that task. Never substitute self-review. The human may explicitly waive it for a named task; record the waiver in `DECISIONS.md`.
- Commits stay local on the run branch recorded in `PLAN.md`. Never push unless the human asks.
- Ask the human in plain prose with a recommendation. Explain what needs attention, why it matters, and the choices. Keep digests, JSON, and internal paths out of it unless asked.

Everything else in this skill and in `PROTOCOL.md` is a default. Adapt numbers and procedure to the work, and record material adaptations in `DECISIONS.md`.

## Plan the run

Pick the run branch first. If the checkout is on the repository's default branch, create and check out a branch named after the run; otherwise ask whether to use the current branch. Record it in `PLAN.md`; every run commit lands there.

Check that `archflow-local --help` lists the `review` command; if it does not, the installed ArchFlow predates this skill, so ask the human to reinstall and stop. Understand the ask, the repository, and its instructions. Delegate research to sub-agents when the size of the work calls for it, and persist what later sessions need under `.archflow/runs/<name>/research/`. Requirements are sized to the work. A paragraph is enough when the target is well understood, such as a port of known software. When the product intent is new or ambiguous, interview the human until the requirements are settled.

Write `PLAN.md` from `templates/PLAN.md`. It holds:

- requirements;
- the architecture decisions tasks depend on;
- invariants every agent follows;
- the agent check command: targeted tests for the changed files plus fast checks such as typecheck and lint, quick enough that no sub-agent waits on it, and leaving the worktree unchanged (no auto-fix, no snapshot writes, outputs gitignored) because a reviewer runs it while the counter-review reads the same worktree; and the full suite, which only the orchestrator runs;
- model routing per kind of task;
- milestones;
- the task table;
- declared STOPs.

Detail the first milestone's tasks now. Later milestones may be marked "detailed at start" when earlier work should shape them. Size tasks so one agent finishes each in a single focused spawn, and split anything larger before it is spawned. Create `DECISIONS.md`, `PROGRESS.md` from `templates/PROGRESS.md`, `reviews/`, and a `.gitignore` containing `packets/`.

Generate run-specific agents when the run has standing guidance that applies across many tasks of one kind. Examples: the reference to compare against and how to validate against it, porting rules, domain invariants, review lenses. Build them from `templates/agents/` into `.claude/agents/<name>-<role>.md`, one per distinct kind of work, and list them in the plan's routing table. Standing guidance belongs in the agent; anything specific to one task belongs in its packet. When no such guidance exists, generate the agents from the scaffolds with only the run's paths and commands filled in. The cross-model reviewer never sees agent files, so write the standing reference-and-validation guidance as a short `BRIEF.md` in the run directory; every counter-review receives it.

Counter-review the plan before the human sees it. Write the human's ask to the run's `packets/plan-cr<k>/ask.txt` and the plan plus each generated agent's standing guidance to `plan.txt` beside it. Then run `bash <this skill directory>/scripts/counter-review.sh <repository root> <that directory> claude plan`, in the background. The review's subject is every uncommitted run and agent file. Read every report in `summary.json`. Fix supported defects and dismiss the rest with reasons.

Then STOP 0. Commit the run files and agents with the status `AWAITING USER (STOP 0)`. Present the plan conversationally:

- scope and requirements;
- milestones and declared STOPs;
- the generated agents and their routing;
- what the counter-review changed;
- any decision the human should make.

When the human revises the plan at STOP 0, apply the revision. A significant change to scope, architecture, tasks, or agents runs the plan counter-review again before approval; a wording or formatting change does not.

On explicit approval of the final plan, record it in `PROGRESS.md`, set the status to `RUNNING`, commit, and recommend a fresh session for execution. A fresh session loads the new agent definitions and starts with a clean context.

## Execute a batch

Follow `PROTOCOL.md`:

1. **Resume.**
   - Read only the run's control files: `PLAN.md` by section, `PROGRESS.md` and `DECISIONS.md`.
   - Reconcile the task log with `git log`; git wins.
   - Hand any uncommitted leftovers from a dead session to a reviewer before anything else.
2. **Run tasks through the per-task loop:** packet, implementer in an isolated worktree, a fresh reviewer and your own counter-review of that worktree in parallel, a fresh merge-mode reviewer that folds the finished counter-review into the findings, a fresh fixer for critical findings, squash-merge, one commit per task. Run independent tasks in parallel when their files do not overlap. Sub-agents run only targeted tests; full suites and slow test groups are yours. Never resume or message a sub-agent that has been idle: its prompt cache is gone after about five minutes, so every fix, re-review, or answered question goes to a fresh agent.
3. **At a milestone end:**
   - Run the milestone's declared gate lenses.
   - If the next milestone is "detailed at start", write its task rows and counter-review them with `stage:"plan"` before spawning any of them. That review needs no human gate unless the milestone changes requirements scope or an accepted decision.
4. **Hand off.**
   - When to stop: after the batch (typically 8–10 merged tasks), or earlier when this session's context grows heavy.
   - What to do: run the full suite, write the session handoff into `PROGRESS.md`, commit, and tell the human to start a fresh session with this skill and the run name.

Keep the orchestrator's context small: it is re-read on every turn. Prefer reviewer verdict lines and findings tables to whole reviews or diffs, and bounded windows or delegation to reading large design or source files whole. Let completion notifications wake you instead of polling.

## STOPs and completion

At a declared STOP:

- Write `reviews/STOP-<n>-report.md`. It covers what shipped, exact steps to try it, gate results, deferred findings, and decisions needed.
- Set the status to `AWAITING USER (STOP <n>)`, commit, and present the report conversationally.
- Resume only on the human's explicit answer, and record it in `PROGRESS.md`.

When the last milestone passes, write a final STOP report and set the status to `COMPLETE` after the human accepts it. Then:

- Propose durable, task-independent conventions the run discovered for the repository's `CLAUDE.md` or `AGENTS.md`.
- Remind the human that `.archflow/runs/<name>/` and the run's generated agents are working files to delete before opening a PR.
