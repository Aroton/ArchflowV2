# Run protocol

This is the working procedure for `/archflow-run`. The skill's trust boundaries are the hard rules. Everything here is a calibrated default: adapt it to the work, and record material changes in the run's `DECISIONS.md`.

A run's state lives in its files and in git, not in any session's context. Any fresh session can pick up where the last one stopped.

## Run files

```
.archflow/runs/<name>/
  PLAN.md          requirements, architecture, invariants, commands, routing, milestones, task table, STOPs
  PROGRESS.md      status line, pending question, milestone board, task log, decisions to report, deferred findings, gate log, handoffs
  DECISIONS.md     ADR log: ## ADR-NNN <title> (decided by human | orchestrator, status, context, decision, consequences, how to undo)
  BRIEF.md         the reference-and-validation brief every counter-review receives
  research/        planning.md (the planner's brief) and the explorers' notes, one file per area
  packets/         per-task context packets (gitignored, regenerated on demand)
  reviews/         <id>-impl.md, <id>-r<k>.md, gate-<milestone>-<lens>.md, STOP-<n>-report.md
.claude/agents/<name>[-<domain>]-<role>.md   generated run agents (Claude Code); see "Run agents"
```

`PROGRESS.md` starts with one status line:

```
**STATUS: PLANNING | AWAITING USER (STOP n) | AWAITING USER (halt) | RUNNING | COMPLETE**
```

Follow it with one sentence on where to resume.

## Resume (start of every execution session)

1. Read `PROGRESS.md` and `DECISIONS.md`. Read `PLAN.md` by section, not whole when it is large. Do not read research or reference material yourself; sub-agents read it through packets.
2. Run `git status` and `git log --oneline -15`.
   - Each merged task has a commit whose subject starts with `<name> <id>:`. When the task log and git disagree, git wins: correct the log.
   - Uncommitted changes or leftover agent worktrees mean a previous session died mid-task. Send them to a reviewer before spawning new work, then merge or discard them deliberately.
3. Compute the ready set: tasks in the current milestone whose dependencies are all merged and that are not already in flight.

## Model routing

`PLAN.md` holds the routing: which generated agent, model and effort handle each task. The two are chosen separately. The agent follows the kind of work, because that decides what guidance the task needs (see "Run agents"). The model and effort follow how hard the task is: spend capability where an error is expensive and hard to detect, and save it where the work is well specified and a review will catch a slip.

Three roles split the run's cost:

- **The orchestrator runs on `opus` at `high` effort.** Its context is re-read on every turn of a long session, so its model sets most of what a run costs. It keeps the judgment that needs the whole run in view: the requirements, the packets, the decision on each finding, merges, and the conversation with the human.
- **The plan is written on the strongest model available (`fable` today), always.** An error in the plan is repeated in every task built on it, and writing it is one bounded spawn, not a session. So the planner is where the strongest model is the default, not the exception.
- **Exploration runs on the cheapest model (`haiku`), at `xhigh` effort.** Locating code and describing what is there needs no strong model, but the planner builds on the notes, and Haiku is the one model that keeps gaining well past `high`. At its price the extra effort costs little; the planner reads the notes and looks up the rest itself.

Other sub-agents do the reading and writing, most of them on a cheaper model than the orchestrator's. Defaults for the current Claude models, to adapt per run:

| Work | Model | Effort |
|---|---|---|
| Orchestrate (this session) | `opus` | `high` |
| Explore during planning: locate code, map files, collect conventions and commands | `haiku` | `xhigh` |
| Research that needs judgment: compare approaches, read a specification or a design | `sonnet` | `medium` |
| Write the plan; detail a later milestone; a significant plan revision | `fable` | `high` |
| Implement: plumbing, registries, mechanical or tightly specified changes | `sonnet` | `medium` |
| Implement: core, algorithmic, correctness-critical, or interface-defining work | `opus` | `high` |
| Implement: the few tasks where a subtle error is costly and a review is unlikely to catch it (concurrency, security boundaries, data migration, a novel algorithm) | `fable` | `high` |
| Task review of a `full` task, and fix verify | `opus`; `fable` when the work under review was routed to `fable` | `high` |
| Task review of a `light` task | `sonnet` | `medium` |
| Merge a finished counter-review into the findings | `sonnet` | `medium` |
| Verify a doubted finding | `opus` | `high` |
| Deferral pass | `opus` | `high` |
| Plan review; fidelity and architecture gate lenses | `fable` | `high` |
| Dogfood and runtime gate lenses | `opus` | `high` |
| Fix | the model that implemented the task; `sonnet` for small, mechanical findings | as the implementer |

How to use the table:

- **Always name the effort.** The models' own defaults differ (Opus runs at `medium` when none is given, Sonnet and Fable at `high`), so write `model` and `effort` into each generated agent's frontmatter and pass both on every spawn that differs from it. This skill asks for those per-spawn values; follow the plan's table.
- **A reviewer is at least as strong as the work it reviews.** A generated reviewer serves several modes, so its frontmatter carries the task-review default and the other modes are per-spawn overrides.
- **`high` is the floor for `opus` and `fable`.** A model usually loses a good deal between `high` and `medium`, so no route sends work to either below `high`. `medium` is for `sonnet` on work a review will catch.
- **Raise the model before the effort.** Most of a model's gain arrives by `high`; `xhigh` and `max` cost many more tokens for an uneven gain. Haiku is the exception: it is cheap enough, and gains enough, to explore at `xhigh`. When an agent returns `blocked`, or a fix still fails its verify after two fix rounds, send the next fresh agent one model up at the same effort. Keep `xhigh` for a task that has already failed at `fable` and `high`.
- **Cost scales with the tier:** per token, Opus costs about twice Sonnet and Fable about twice Opus, and Haiku costs a small fraction of Sonnet. A run with most tasks on `fable` usually means the tasks are too large or under-specified; split them or sharpen the packets instead.
- **The plan-writing route does not move down.** The plan may adapt every other row, and a run may route more work to a cheaper model. Writing the plan stays on the strongest model.
- **Size before routing.** If a task mixes levels of difficulty, split it, or route it to the more demanding one. A task that spans domains is split the same way (see "Run agents").

Model names age. When newer models exist, keep the shape (the cheapest model explores, a cheap one does well-specified work, a stronger one orchestrates and does core work and review, the strongest writes the plan and takes the rare hard task) and record the run's mapping in `PLAN.md`.

## Planning agents

Planning runs before the run's generated agents exist, so explorers and the planner are general-purpose sub-agents with the model and effort passed on the spawn. Each gets a complete brief, because it sees none of the conversation, and each is fresh: the rules under "Never resume an idle agent" apply here too.

**Explorer.** One area or question per explorer, on the exploration route. Its prompt names the area, what the run is about in a sentence or two, and the output file `<run dir>/research/<topic>.md`. A useful note lets the planner go straight to the right place:

- what exists, with paths and line pointers, and how the parts connect;
- the conventions the code follows there, and the repository instructions that apply;
- the commands that build, typecheck and test it, including how to run tests for a few files only;
- what it could not find or is unsure of.

An explorer describes what is there. It does not propose a design, and it says so when a question needs more judgment than a lookup; that question goes to the research route. It returns a few lines: the file it wrote and what it covers.

**Planning brief.** `research/planning.md`, written by the orchestrator, is the planner's starting point: the ask in the human's words, the settled requirements and each decision the human made, the run branch, the active review triggers, and an index of the research files. It is updated when the human answers a question, so a fresh planner starts from the current state.

**Planner.** One fresh sub-agent on the plan-writing route. Its prompt names the brief, the run directory, this skill directory, and which of three jobs it has:

- **First plan.** Read the brief, this file, and `templates/`. Read the research, then look up in the code whatever the research leaves open; the research is a map, not a limit. Write `PLAN.md` from `templates/PLAN.md`, the consequential choices as ADRs in `DECISIONS.md` (marked `human` when the brief records the human's decision, `orchestrator` otherwise), the generated agents, and `BRIEF.md`.
- **Revision.** The prompt carries the counter-review points the orchestrator accepted, or the human's revision. Change what they require in the plan, the ADRs, the agents and `BRIEF.md`, and keep the rest.
- **Milestone detail.** For a milestone marked "detailed at start": read the plan, `PROGRESS.md` (handoffs, deferred findings, decisions) and `DECISIONS.md`, look at the merged code the milestone builds on, and write the milestone's task rows, each with its agent and review depth. Correct an architecture detail the run has shown to be wrong, and add or revise a domain's agents when the milestone opens a kind of work the roster does not cover; say so in the return.

`PLAN.md` holds:

- requirements, as the brief settled them;
- the architecture decisions tasks depend on;
- invariants every agent follows;
- the agent check command: targeted tests for the changed files plus fast checks such as typecheck and lint, never a full build, as quick as the targeted scope allows (agents wait on it through `scripts/wait.sh`), and leaving the worktree unchanged (no auto-fix, no snapshot writes, outputs gitignored) because a reviewer runs it while the counter-review reads the same worktree; and the full build and full suite command, which only the orchestrator runs;
- the agent roster, with what each agent covers and why it is its own agent (see "Run agents");
- model and effort routing per level of difficulty, starting from the defaults under "Model routing";
- milestones;
- the task table, with a review depth on every row (see "Review depth");
- declared STOPs.

Detail the first milestone's tasks. Later milestones may be marked "detailed at start" when earlier work should shape them. Size tasks so one agent finishes each in a single focused spawn (see "Task sizing and the plan table").

Generate the run's agents as "Run agents" describes, and list them in the plan's agent roster. The cross-model reviewer never sees agent files, so write the standing reference-and-validation guidance as a short `BRIEF.md` in the run directory, with a section per domain when the run has several; every counter-review receives it.

The planner ends with the return block under "Sub-agent contract". Its NOTES give the main architecture choices, the milestones and the risks in a few lines; the orchestrator reads the plan itself by section. A question whose answer is the human's (a requirement the brief leaves open, a choice between products rather than between designs) comes back as `needs-decision`, with what the planner would assume; the orchestrator asks the human and spawns a fresh planner. The planner does not commit, and it writes only the run's files and agents.

## Run agents

The planner generates the run's agents from `templates/agents/` into `.claude/agents/`. An agent is a role scaffold filled with the standing guidance of one kind of work. The roles are few and the same in every run, because their mechanics (the return block, waiting on commands, the context budget, the scope rules) do not depend on what is being built. The kinds of work, called domains here, are what each run decides.

**Where guidance lives.** Put each piece of guidance at the scope it applies to:

| It applies to | It lives in |
|---|---|
| every task in the run | the plan's invariants |
| every task of one kind | that kind's agents |
| one task | its packet |

**When a kind of work is a domain.** An agent specialized to its work does it better than a general one handed the same task, and each agent is a file to write, review and keep true. A kind of work earns its own agents when an agent that knew only the invariants would do it differently from what the work needs, because it differs from the rest of the run in at least one of:

- what correct is checked against: an analytic solution or a reference engine, a design specification, the behavior of a real database;
- how it is validated: the check command, the style of test, a tool or environment such as a browser or a database container;
- how it goes wrong: numerical stability and determinism in one place, accessibility and state handling in another, transactions and migrations in a third;
- the conventions of that part of the codebase.

The guidance must also be standing: it serves several tasks, typically three or more. One or two tasks of a kind go to the general agent, with their guidance in the packet.

Split where the guidance changes, and no finer. A physics engine, a UI and database integrations are three domains; collision detection and the integrator are tasks of one. Directory, layer, task size, milestone and model tier are not domains: model and effort are chosen per spawn. A run typically has one to four domains. When two agents' guidance would differ by a few lines, merge them. A roster past about five usually means tasks have been mistaken for domains.

**The roster.**

| Agent | Generated | Takes |
|---|---|---|
| `<name>-<domain>-implementer` | per domain | implementing the domain's tasks, and fixing their findings in fix mode |
| `<name>-<domain>-reviewer` | per domain, by default | the reviews of one task in the domain: task-review, merge, fix-verify, verify |
| `<name>-implementer` | always | tasks outside every domain: glue, configuration, documentation, a kind with too few tasks to be a domain |
| `<name>-reviewer` | always | the reviews of those tasks, and the reviews that span the run: deferral, plan-review, gate lenses, leftovers from a dead session |

- A domain's implementer and reviewer come as a pair, because they share the reference and how to validate against it. The planner may leave out a domain's reviewer when reviewing that work needs nothing the general reviewer lacks.
- When the whole run is one kind of work, the general pair carries its guidance and no other agents are generated.
- There is no separate fixer agent. A fix needs the same guidance as the work it corrects, so a fixer is a fresh spawn of the task's implementer agent in fix mode. It has none of the implementer's context because it is a new agent, not because it is a different definition.
- A gate lens that judges one domain, such as the fidelity of the physics, may go to that domain's reviewer.
- Explorers, the planner and the cross-model reviewers are not generated: each gets what it needs in a brief (`research/planning.md`, `BRIEF.md`).

A task's row names its implementer agent. Its fixes go to that agent, and its reviews to the reviewer of the same domain, or to the general reviewer when the domain has none. Split a task that spans domains. A task that joins two domains goes to the domain whose guidance covers the larger risk, or to the general agent with both interfaces in its packet.

**Writing the guidance.** Fill each scaffold's `Domain guidance` section with what a strong engineer new to this run would not know: the reference and how fidelity is proven, the domain's rules and decisions here, where this work goes wrong, the conventions of that code, and the tools it needs. It is not a tutorial on the field. A reviewer's section holds the same reference and validation, plus the lenses to review that work through. The general pair holds only what is true of any task in the run; when no standing guidance exists, generate it from the scaffolds with only the run's paths and commands filled in. Fill `{{skill dir}}` with this skill directory's absolute path, so agents can run `scripts/wait.sh` from any worktree, and give each agent the agent check its domain uses.

**Changing the roster mid-run.** The run learns what its agents should have been told. When the same finding returns across a domain's tasks, the lesson belongs in that domain's agents: add the line yourself, in the implementer and the reviewer, and record it as the skill's "Who decides" describes. Adding, removing or re-scoping an agent is a plan revision and goes to a fresh planner, as does a milestone that opens a new domain. Agent definitions load when a session starts, so a new or changed agent takes effect in the next fresh session. Until then, send that work to the general agent with the guidance in its packet.

## Sub-agent contract

**Packet.** Before spawning, write `packets/<id>.md`. Keep it bounded, typically under 25k tokens. It holds:

- the task row;
- the goal and files of each dependency;
- deferred findings this task carries;
- the plan sections the row cites;
- any external reference material the agent needs verbatim.

Agent sandboxes may not reach the network, so fetch references into the packet instead of trusting an agent to fetch them. Agents read the packet instead of the design documents.

**Prompt.** Pass the packet's absolute path, because worktrees do not contain the gitignored packet directory. Also pass the agent's mode, the base commit, any extra task-specific pointers, and the exact output paths. The generated agent definition already carries the standing guidance, the context-budget rules and the return format, so a prompt is typically 20–40 lines.

**Return format.** Every agent ends with a short block, typically 15 lines or fewer, and writes anything longer to its output file:

```
STATUS: done | blocked | needs-decision
FILES: <written/changed paths>
VERDICT: <one line; reviewers: PASS | FIXES-NEEDED (n critical, n major, n minor)>
NOTES: <≤3 bullets>
EXTRA: <implementers and fixers: work done beyond the task row or the listed findings, each with why it was needed; or none>
QUESTIONS: <only if blocked/needs-decision>
```

`EXTRA` is how a sub-agent hands you work it judged necessary but was not asked for: a defect fixed in code the task depends on, a caller or test its change broke, a criterion it found to be wrong. The agent does the work and reports it; you decide whether it stays, in step 5 of the per-task loop.

`needs-decision` means the agent stopped because going on would drop or weaken a requirement, contradict a decision marked `human`, or do something risky the packet does not cover. Decide it yourself whenever the skill's "Who decides" makes it yours, which it usually is when the question is only that the packet or `DECISIONS.md` did not cover the case. Halt for the human only when the decision is on their list: put the question to them in your own words, with the context they need, the choices, and your recommendation, as the skill's "Talking to the human" describes. Either way, the answer goes to a fresh agent, never back to the one that asked.

**Never resume an idle agent.** A sub-agent's prompt cache lasts about five minutes. An agent resumed or messaged after that re-reads its whole context uncached, which typically costs more than a fresh agent reading one packet and one review file. So:

- every spawn is a fresh agent that finishes its job in one go and returns;
- fixes go to a fresh fixer, the check of a fix to a fresh reviewer, and decisions to a fresh agent with the decision in its prompt;
- no sub-agent step waits on a review. The orchestrator runs the counter-review itself, alongside the reviewer rather than before it, and hands the finished result to a fresh reviewer that merges it. The orchestrator is the one session that waits, and its own cache outlives a typical review;
- sub-agents run only the plan's agent check, scoped to the files they touched: targeted tests plus typecheck-level checks such as `tsc --noEmit` or `cargo check`. Full builds (a whole-workspace or release compile, a bundle), the full suite and any slow test group belong to the orchestrator. A full build in each of several parallel agents can take the machine down. An agent that thinks a build or broader verification is needed says so in NOTES;
- a sub-agent that waits on a command keeps its cache warm. A slow host or a command whose result the agent genuinely needs can still outlast five minutes, so agents run installs, targeted tests and the agent check through this skill's `scripts/wait.sh`. It runs the command in the background and returns after about four minutes when the command is still running; each return is a small turn that refreshes the cache, and the agent waits again until the command finishes. A quick command finishes within the first wait, so agents use it for any command that might take more than a minute. `wait.sh stop <handle>` ends a stuck command together with everything it started. Generated agents carry the script's absolute path.

## Review depth

Each task row carries a `review` depth, approved with the plan at STOP 0:

- **`full`**, the default: the task changes behavior. That covers source code, test logic, schemas, build or CI configuration, and anything that touches a path under an approval rule or a kind of change a constitution trigger names. It gets the in-model review and the cross-model counter-review.
- **`light`**: a mistake in the task is cheap and easy to see. Documentation, comments, wording, formatting, regenerated files, a rename the typecheck proves. It gets the in-model review only. Its cross-model coverage is the milestone counter-review.

Depth follows what the diff does, not what the row expected. Raise a task to `full` whenever you judge it needs it, and always when a `light` task's diff turns out to change behavior; its reviewer says so. Lowering a task that changes behavior is the human's to waive. A task you add mid-run takes its depth from the same criteria.

## Per-task loop

A change gets one open-ended review. A fresh reviewer asked to review again finds something every time, because it has no memory of the round before, so a second open-ended pass over the same work mostly re-judges what the first already judged. After a fix, the question is narrower, and it has an answer: is each finding fixed, and did the fix break anything? Steps 2–5 are the review; step 6 is that check.

1. **Implement.**
   - Spawn the implementer agent the task's row names, in implement mode, with worktree isolation. Its setup brings the fresh worktree to the base commit you name (`git reset --hard <sha>` is safe in a fresh worktree) and installs dependencies.
   - It writes code and tests, runs the plan's targeted agent check command on its changed files until it passes, writes `reviews/<id>-impl.md` in its worktree when a fixer or reviewer needs more than its short return, and never commits.
   - Run tasks in parallel only when their file sets do not overlap: typically a handful at once, limited by machine load more than by the model.
2. **Review, once.** When the implementer returns, start the task's reviews together. Other tasks keep moving while they run.
   - Spawn a fresh reviewer: the reviewer agent of the task's domain, which also takes this task's later merge, fix-verify and verify spawns. Give it the worktree path, the base commit, the packet, the task's review depth, the implementer's `EXTRA`, and the output file `<run dir>/reviews/<id>-r1.md` as an absolute path in this session's checkout. It runs the targeted check command, reviews the diff against the acceptance criteria, writes its findings table, and returns its verdict without waiting for the counter-review.
   - For a `full` task, run the cross-model counter-review on its worktree yourself, in the background (see below). A `light` task has none.
3. **Merge the counter-review** (`full` tasks). When both have finished and the counter-review produced any reports, spawn a fresh reviewer in merge mode, with the review file, the worktree path, the packet, and the counter-review's `summary.json`. It folds each counter-review point that matches an existing row into that row, adds a row for every other material point, adds each `human_review_reasons` entry as a row with source `human-review`, and updates the verdict. Then:
   - read only the verdict line and the table: `grep '^|' <review>`;
   - a failed counter-review still blocks the task until it runs or the human waives it;
   - a `human-review` row is yours to triage (see "Human-review reasons" below): it becomes a halt only when it names a decision that is the human's.
4. **Verify a doubted finding (optional).** When you doubt a finding you would act on, send it to a fresh reviewer whose job is to disprove it, ideally with a minimal test. It marks each finding CONFIRMED or REJECTED. Batch doubted findings into one verifier. A row both model families raised independently is rarely wrong; a row from one source with no demonstrated failure is where a verify is worth its cost.
5. **Decide and fix.** Decide every row in the merged table. For a finding, do not decide by severity alone: severity tells you how bad it is; whether to fix it now depends on what leaving it costs.
   - **Unplanned work** (source `unplanned`, and the implementer's or fixer's `EXTRA`): keep, trim or revert it. This is your call, not the human's, unless keeping it would be a decision on the human's list.
     - Keep it when the task needed it, or when it is a correct fix that costs less to keep than to redo.
     - Trim or revert it when it widens the run without need, or move it to its own task when it deserves its own review.
     - When keeping it changes what the task row, a criterion or the architecture says, correct `PLAN.md` and the packet, so later checks judge against the corrected row, and record the call as the skill's "Who decides" describes.
     - A reverted piece goes to the fixer with the other fix-now rows.
   - **A criterion or plan detail the code has shown to be wrong:** correct the plan instead of bending the code to it, on the same terms.
   - **Fix now** every confirmed critical, and any major or minor where leaving it costs more later:
     - it has knock-on effects: dependent tasks build on the code, it shapes an interface or pattern others will copy, or it would make a later fix touch more files;
     - it is a real bug, not a style point: wrong output in an edge case, lost data, a security or resource leak;
     - the fix is cheap now while the context is fresh, and expensive to rebuild later;
     - no later task touches that code, so deferring means nobody owns it.
   - **Defer** when it does not matter yet: it is cosmetic, a task that will rework that code anyway is the better place for it, or fixing it now would widen this task's scope. Record why in `PROGRESS.md` (see below).
   - **Dismiss** a finding that is wrong or not worth doing at all, with the reason in the review file.
   - Write each decision as a line under the round's table in the review file: `<row id>: fix | defer → <owner> | dismiss | keep | revert | decided | halt — <reason>`.
   - Fix-now findings go to a **fresh** fixer: a new spawn of the task's implementer agent in fix mode, given the review file, the finding ids, the packet and the worktree path. Never resume the implementer for fixes.
   - Before spawning the fixer, record the worktree's current tree, so the fix can be checked on its own: `cd <worktree> && git add -A && git write-tree > <run dir>/packets/<id>-pre-r<k+1>.tree && git reset -q`. When the fixer returns, record the fixed tree the same way into `<id>-post-r<k+1>.tree`.
   - When nothing needs fixing now, the task goes straight to the merge.
   - Deferred findings go under "Deferred findings" in `PROGRESS.md`, each with a reason and the task that owns it, and into that task's packet.
   - You may make trivial fixups yourself, typically 10 lines or fewer, in the worktree. List one made after the review in the task's review file as not separately reviewed; the milestone counter-review covers it. Anything larger is a fix: it goes to a fixer and gets checked.
6. **Check the fix.** Check what the fixer changed, not the task again.
   - **Always: fix verify.** Spawn a fresh reviewer in fix-verify mode with the review file, the finding ids sent to the fixer, both tree IDs (the contents of the two `.tree` files), the packet, and the fixer's `EXTRA` and `ORACLE` lines. It appends round `r<k+1>` to the review file. For each finding it says whether the fix resolves it and on what basis:
     - `test`: a test exercises the finding's failure scenario and passes, and its expected values do not come from the fixer's own computation;
     - `reference`: the verifier compared the result with the run's reference itself;
     - `reading`: neither; it could only read the code and judge it right.

     It reads the fixer's changes for anything they broke, and adds a row only for a regression those changes caused or a listed finding that is still open. It does not review the rest of the task again.
   - **When the fix is hard to check: a cross-model delta review as well.** An in-model verifier is reliable on "does the code now do what the finding asked". It is unreliable on "is this new reasoning right", because it shares the fixer's model family and tends to repeat its mistake. So the question is whether the fix can be checked against something the fixer did not produce:

     | The fix | Check |
     |---|---|
     | corrects a value, a condition, a missing case, a call or a name, and has a test that fails without it | verify |
     | adds logic whose expected results come from the reference or another independent source | verify |
     | adds or replaces derived logic (a formula, a numerical method, an algorithm, ordering or concurrency, a parser, a security check) that the verifier could confirm only by `reading`, or whose test values are the fixer's own | verify and delta review |
     | fixes a correctness finding in derived logic that only the cross-model reviewer raised, and the in-model reviewer missed or disputed | verify and delta review |
     | is a rework: it replaces the approach, or changes an interface other tasks build on | verify and delta review |

     Lean toward the delta review for the tasks the plan routes as subtle and hard to review, whenever a fix touches their core logic. Write the row that applied on the round's decision line. When the kind of finding already settles it, run the delta review beside the verifier; otherwise decide from the verifier's result. See "Delta review of a fix" below for how to run one. Its points are merged into round `r<k+1>` by a fresh merge-mode reviewer and decided like any others.
   - **Typically one delta review per task.** Its findings are fixed and verified. Run another only when that fix is again derived logic the verifier cannot confirm.
   - A finding the verifier reports as not resolved, or a regression, goes to another fresh fixer and another fix verify, with fresh tree IDs. A verify can only reopen what it was asked to check, so these rounds end.
   - Default limit: three fix rounds. After that, defer or dismiss what is left that is not critical, or rescope the task. A critical still unresolved is a halt for the human.
7. **Merge.**
   - In the worktree, run `git add -A` and make a scratch commit.
   - In this session's checkout, run `git merge --squash <worktree branch>` (the branch is `git -C <worktree> branch --show-current`).
   - Resolve conflicts that have a mechanical owner (regenerate generated files, take the union of append-only registries). Halt on any conflict that needs judgment.
   - Never use a bare `git stash`: the stash stack is shared with every other worktree and session.
8. **Commit.**
   - One commit per task, subject `<name> <id>: <imperative summary>`. The squash merge has staged the task's changes; add the task's own review files by path (`git add <run dir>/reviews/<id>-*`) and the `PROGRESS.md` tick, and commit the index. `git add -A` in this checkout would sweep in other in-flight tasks' review files.
   - Tick the task log in `PROGRESS.md` with the short SHA and the review summary. Close each deferred finding this task carried, using the reviewer's `carried` rows: fixed, with the SHA, or still open and routed to a new owner. The tick can ride along with the next commit.
   - Remove the worktree and its branch.
9. **Full suite and build.** Only the orchestrator runs them, once per batch, serialized, not once per merge. The same goes for any slow test group the agent check leaves out. Several sub-agents running it in parallel overload the machine, and each one spends the wait in keep-alive turns. Bisect a failure by task and send it to a fresh fixer.

## Cross-model counter-review

`scripts/counter-review.sh` in this skill directory runs ArchFlow's standalone counter-review (`archflow-local review`) on the directory you give it. Under the routing in the repository's `.archflow/config.yaml` (or ArchFlow's shipped defaults), it dispatches:

- a counter-reviewer from the opposite model family;
- a test reviewer;
- a constitution reviewer when constitution rules exist.

That is the first review of a change. The script's optional fifth argument names a subset of those roles (`counter-reviewer`, `test-reviewer`, `adjudicator` for the constitution reviewer, comma-separated), for a pass that should not repeat a concern that already ran:

- The test reviewer and the constitution reviewer run once per task. Once each has reported, do not run it again for that task: its findings are fixed and verified like any others, and the milestone counter-review sees the integrated result.
- A delta review runs `counter-reviewer` alone.
- A role whose dispatch failed has not reported. Retry that role alone.

For a `full` task's first review, write its inputs into `<run dir>/packets/<id>-cr<k>/`, which is gitignored and outside the worktree, without reading the material into your own context:

```bash
out=<run dir>/packets/<id>-cr<k>; mkdir -p "$out"
grep -E '^\| <id> \|' <run dir>/PLAN.md > "$out/ask.txt"   # the task row, acceptance tests included
cat <run dir>/packets/<id>.md <run dir>/BRIEF.md > "$out/plan.txt"
printf '%s\n' "<check command>: <result the implementer or fixer reported>" > "$out/verification.txt"
bash <skill dir>/scripts/counter-review.sh <worktree> "$out" claude implementation
```

Run the last command in the background; reviews often take several minutes. It prints one status line and writes `result.json`, `summary.json` and `exit` into `$out`. `--producer` is the client running the run (`claude` in Claude Code). The subject is every changed and untracked file in the worktree outside `.archflow/runs/`: the run's own ledger and notes are context for the reviewers, not work under review. The review requires the worktree HEAD to still be the base, which holds because implementers and fixers never commit.

The worktree holds the plan as it was at the base commit, so tell the reviewers what you have decided since. `ask.txt` is read from the current `PLAN.md`, which carries any row you corrected. When you decided to keep unplanned work, or directed work beyond the row in a fix round, add one line saying so to `ask.txt` (`Orchestrator decision: <what is now part of this task, and why>`). Reviewers then judge the work against the decision instead of reporting the difference again.

A nonzero exit is not a pass. An `INPUT_INVALID` error names the input to correct. `SUBJECT_CHANGED` from a review that ran beside a reviewer means something wrote into the worktree meanwhile, usually the agent check: fix the check command in `PLAN.md` and rerun the counter-review on its own. A failed reviewer route may be retried once, naming only that role; if it still fails:

- the task is blocked until the review runs;
- the human may waive it for that task;
- the waiver is recorded in `DECISIONS.md`.

When the installed `archflow-local` has no `review` command, ArchFlow needs reinstalling; tell the human rather than installing it yourself.

### Delta review of a fix

A delta review puts only the fix in front of the cross-model reviewer. The review's subject is whatever differs from `HEAD` in the directory it runs on, so build a scratch worktree whose `HEAD` is the task as it stood before the fixer and whose only change is what the fixer did:

```bash
pre=$(cat <run dir>/packets/<id>-pre-r<k>.tree); post=$(cat <run dir>/packets/<id>-post-r<k>.tree)
c=$(git commit-tree "$pre" -p <base sha> -m "<id> before fix r<k>")
wt=$(mktemp -d)/wt; git worktree add -q --detach "$wt" "$c"
git diff --binary "$pre" "$post" | git -C "$wt" apply --index
out=<run dir>/packets/<id>-cr<k>; mkdir -p "$out"
{ grep -E '^\| <id> \|' <run dir>/PLAN.md
  printf '%s\n' "This is a review of a fix, not of the whole task. The baseline already holds the task's reviewed work; the subject is only what the fixer changed." \
    "Findings being fixed: <each id with its claim>." \
    "Judge whether each fix is correct and complete, and whether it breaks anything." \
    "Already decided, not to be reopened: <deferred and dismissed rows, and your decisions on unplanned work>."; } > "$out/ask.txt"
cat <run dir>/packets/<id>.md <run dir>/BRIEF.md > "$out/plan.txt"
printf '%s\n' "<check command>: <result the fixer reported>" > "$out/verification.txt"
bash <skill dir>/scripts/counter-review.sh "$wt" "$out" claude implementation counter-reviewer
```

Remove the scratch worktree afterwards with `git worktree remove --force "$wt"`. The scratch commit is on no branch and needs no cleanup. Because the review reads its own worktree, it can run while the verifier works in the task's worktree.

### Human-review reasons

A `human_review_reasons` entry is a reviewer's claim that a human is needed. It is evidence for you to weigh, not a verdict that stops the run: the reviewer cannot see what the human delegated to you. Triage each one against the skill's "Who decides" and write the outcome under the round's table.

- **Halt** when the reason names a decision on the human's list: the work changes what they get, reverses something they decided, or carries a risk the plan does not cover.
- **Halt** when the reason reports a kind of change the repository's rules single out for a human, such as database behavior or a path under an approval rule, and the change is real. The repository owner asked to see that kind of change, whether or not the plan mentions it. Check the evidence first: a reason that points at a change the diff does not contain is dismissed like any wrong finding.
- **Decide it yourself** when its only substance is that something was done or decided without a recorded human approval, and the thing is yours to decide: unplanned work you kept, a task row or criterion you corrected, a decision of your own, a local commit the plan's approval already covers. Record it as `<row id>: decided — <what you decided, and why it is not the human's>`.
- When a reason shows the plan no longer matches the code, that part is usually right. Correct the plan; it does not need the human unless the correction is theirs to make.

Never drop a reason silently. Each one you decide yourself is listed under "Decisions to report" in `PROGRESS.md`, so the human sees it in the next message that ends a turn and can overturn it.

If the same reason returns on task after task, the repository's rules do not fit an orchestrated run. Say so at the next STOP or handoff, with the rule and how often it fired, and recommend the human review the rule; do not edit the rules yourself.

The plan stage uses the same script with `plan` as the stage, run on the repository root, with `ask.txt` holding the human's ask and `plan.txt` the plan plus each generated agent's `Domain guidance` section. The plan's first review runs every role. A later pass over a revised plan names the roles the revision concerns, usually `counter-reviewer` alone.

A review of the repository root covers every changed and untracked file in this checkout, so run one only when nothing is writing into it: before spawning tasks, or between batches. Agent worktrees nested in the checkout are skipped.

Task worktrees read `.archflow/config.yaml` and the constitution from the committed tree. Commit any change to them before spawning tasks, or task reviews use different routes and policy than the plan review did.

For a whole-milestone counter-review, keep the run's own ledger and review files out of the subject:

```bash
start=<milestone start sha>; wt=$(mktemp -d)/wt
git worktree add -q --detach "$wt" "$start"
git diff --binary "$start" HEAD -- . ':!.archflow/runs' | git -C "$wt" apply --index
```

Then run the script on `$wt` with `implementation` as the stage. `ask.txt` holds the milestone's goal and its task rows, `plan.txt` the plan's architecture and invariants plus `BRIEF.md`, and `verification.txt` the full build and suite result. Remove the worktree afterwards with `git worktree remove --force "$wt"`. A milestone over the review's 25 MiB snapshot limit is reviewed per lane instead.

## Milestones and gates

A milestone ends with the gate lenses `PLAN.md` declares. A useful default set, each lens a fresh reviewer run in parallel:

- **fidelity:** the result against the reference or requirements;
- **architecture:** drift from the plan's architecture, and shortcuts that force rework;
- **dogfood:** use the result the way its consumer will, and report the friction;
- **runtime:** run it end to end.

Run the whole-milestone counter-review as well, by default, with every role. It is the cross-model coverage for `light` tasks, for fixes that were only verified, and for how the tasks fit together, and it is where the test and constitution reviewers see the integrated result. Skip it for a small milestone whose tasks were all `full` and whose fixes were small, and say so in the gate row.

Verdict: PASS, PASS-WITH-DEFERRALS, or FAIL. Any confirmed critical is a FAIL. A FAIL produces fix tasks, each with a review depth by the usual criteria. The one-review rule holds here too: a failed lens re-runs only to check that its own findings are fixed, and the milestone counter-review is not run again. Decide a gate's lesser findings the way the per-task loop does: one with knock-on effects for the next milestone becomes a fix task now.

Record a gate row in `PROGRESS.md`. A gate is not a STOP unless the plan declares one there, so do not stop to report it: the human is not watching mid-run. Include the gate's result in the next message that ends a turn, whether a STOP report, a halt, or the session handoff.

## Deferral pass

Deferring is a decision to revisit, not to forget. At each milestone end, after the gate, go over every open entry under "Deferred findings":

- **Fix:** it matters now. The milestone's work may have raised its cost, or its owner never picked it up. Make it a fix task, or add it to an upcoming task's goal.
- **Carry:** it still does not matter yet and a later task owns it. Confirm the owner exists in the plan.
- **Close:** it no longer applies, or it is not worth fixing. Mark it closed with a reason: already fixed, obsolete, or won't fix because of what it would cost.

When the list is long, or you are not sure an entry still applies, send it to a fresh reviewer in deferral mode, which checks each entry against the current code and recommends one of the three. You decide.

At the last milestone nothing can carry. Every open entry is fixed or closed before the final STOP. The final STOP report lists each won't-fix with its reason, so the human can overturn any of them.

When the next milestone is "detailed at start":

- have a fresh planner write its task rows from what the run has learned, each with its review depth (see "Planning agents"); you do not write them yourself;
- review them once: with the plan-stage counter-review, `counter-reviewer` alone, when they add architecture, interfaces or choices the approved plan does not hold; with a fresh reviewer in plan-review mode when they only continue the approved architecture;
- fix supported findings;
- record the result in `PROGRESS.md`.

## Findings format

Reviewers write one table per round:

```
| id | severity | source | file:line | claim | failure scenario | suggested fix |
```

- `source` says where the row came from:
  - `self`, `counter`, `tests`, `constitution`: a finding from that reviewer. A point two reviewers raised independently is one row naming both, such as `self+counter`: agreement between model families is strong evidence, and a `counter` row the in-model reviewer missed marks where that family may be blind;
  - `carried`: a deferred finding this task was meant to pick up; the claim says whether it is fixed;
  - `unplanned`: work in the diff that the task row did not ask for. The claim says what it is and whether the task needed it; the suggested fix is `keep`, `trim` or `revert`, with the reason;
  - `human-review`: a counter-review `human_review_reasons` entry, quoted in the claim, with the reviewer's check of whether the change it names is really in the diff.
- The suggested fix must be concrete enough for a fixer with no other context.
- When a finding has knock-on effects, such as later tasks building on it or a pattern others will copy, the failure scenario says so. That is what decides fix now or defer.
- Every material counter-review point is in the table, as its own row or folded into the row it matches. A reviewer that disagrees with one keeps the row and gives its evidence; you decide.
- A fix-verify round starts with its own table, `| id | resolved | basis | evidence |`, one row per finding sent to the fixer, followed by a findings table only when the fix caused a regression.

Severity:

- **critical:** wrong behavior or a crash in scope, a broken build or broken tests, an invariant violation, or a departure from the architecture that breaks something or that later tasks would build on wrongly;
- **major:** a missing acceptance criterion, a fidelity error against the reference, or missing tests for core behavior;
- **minor:** every other defect;
- **note:** not a defect, but a row you need to decide: sound unplanned work, a human-review reason, or a criterion or plan detail that the code shows to be wrong. Notes are not counted in the verdict.

Work is judged by what it does, not by whether the plan mentioned it. Doing more than the row asked, or departing from a plan detail in a way that works, is a `note` for you to decide. It becomes a finding only through a concrete consequence.

## Task sizing and the plan table

Agent cost grows faster than linearly with the length of the task. Keep each task reviewable in one pass. A typical ceiling is about 600 changed lines; split larger rows into `a`/`b` rows in `PLAN.md` before spawning, and commit the split on its own.

Task table columns:

```
| id | goal | files | acceptance tests | depends on | size | agent | review | lane |
```

- **Agent** names the generated implementer agent that takes the task (see "Run agents"), followed by `model/effort` when the task departs from that agent's default.
- **Review** is the task's depth, `full` or `light` (see "Review depth").
- **Acceptance tests** name the test file and list concrete assertions.
- **Dependencies**: `Tn` is a hard edge; `Tn (soft)` is a preference.
- **Lanes** group tasks that touch disjoint files, so they can run in parallel.
- **Carry-overs**: deferred findings a task must pick up are appended to its goal, citing their review id.

## Context hygiene

The orchestrator's cost per turn grows with its context:

- Hand off after a batch, typically 8–10 merged tasks, or earlier when the context grows heavy.
- Prefer `grep -n` and bounded windows for large files, or delegate them.
- Query JSON with `jq`.
- Pipe long output through `tail`.
- Let completion notifications wake you instead of polling.

The session handoff in `PROGRESS.md` records:

- tasks merged, as a count of done over total;
- check and suite results;
- anything in flight;
- decisions made, each with how to undo it;
- the carry-over items the next tasks must take;
- a "Next" list.

The handoff is also what the human reads, so the closing message of the session summarizes it in plain language rather than pointing at the file.

## Decisions to report

A call you make on the human's behalf gets one line under "Decisions to report" in `PROGRESS.md` when you make it: what you decided in plain words, why, and how to undo it. That covers unplanned work you kept or reverted beyond a small necessary fix, a task row, criterion or architecture detail you corrected, tasks you added or dropped, and each human-review reason you decided yourself. Routine keeps can share one line per task. The next message that ends a turn reports them all, whether it is a handoff, a STOP report or a halt, and the entries then move into that session's handoff record. A fresh session reports whatever is still listed.

## Halts

Halt only for a decision the skill's trust boundaries give to the human; everything else is decided and reported. A halt between STOPs follows the skill's "Talking to the human". Finish or park what is in flight first: let running agents return and record their results, so the question you ask reflects the whole state and the human's answer is not overtaken by a late result. Other tasks that do not depend on the answer keep going until they are merged; halt when only the blocked work is left, or straight away when the question affects everything. Write the question under "Waiting on the human" in `PROGRESS.md`, set `AWAITING USER (halt)`, commit, and ask once, with everything open in one message.
