# Run protocol

This is the working procedure for `/archflow-run`. The skill's trust boundaries are the hard rules. Everything here is a calibrated default: adapt it to the work, and record material changes in the run's `DECISIONS.md`.

A run's state lives in its files and in git, not in any session's context. Any fresh session can pick up where the last one stopped.

Planning has its own file, `PLANNING.md`: the planning agents, the run's generated agents ("Run agents"), and the test policy defaults ("What tests to write"). Read it when planning. An execution session needs only this file.

## Run files

```
.archflow/runs/<name>/
  PLAN.md          requirements, architecture, invariants, commands, routing, milestones, task table, STOPs
  PROGRESS.md      live state: status line, pending question, resume notes, milestone board, task log, decisions to report, gate log
  DEFERRED.md      the open deferred findings, each with the task that owns it; read by owner, and whole at a deferral pass
  HISTORY.md       the record: each session's report and every closed deferred finding; added to, not read at resume
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

**`PROGRESS.md` holds only what a session needs in order to act next.** Every session reads it whole and then carries it on every turn, and the planner reads it again for each milestone it details, so each line in it is paid for many times. A record of what already happened goes to `HISTORY.md`: a session's report, a deferred finding that closed. The story of a review stays in its review file. `HISTORY.md` is added to at the end and never read whole; search it with `grep -n` when a question needs the past. The open deferred findings are state, but each is needed only when the task that owns it starts, so they live in `DEFERRED.md` and are read by owner. Left to collect both, one run's `PROGRESS.md` reached 141 KB in seven sessions, about two thirds of it text no later session acted on.

**Removing the run.** These are working files: tracked on the run branch while the run is going, and removed before a pull request. `bash <skill dir>/scripts/cleanup.sh <repository root> <name>` removes them: the run directory, the run's generated agents, and any scratch review worktree the run left in the temp directory, in one local commit that `git revert` undoes. It refuses while a run or agent file has uncommitted changes, so nothing it deletes is lost. It keeps and reports anything it cannot prove is this run's, such as an agent file whose description names another run, and it lists the worktrees that remain without touching them or any branch. `--dry-run` shows what it would do. Run it when the human says to remove the run, at completion or to drop an abandoned run; see the skill's "STOPs and completion".

## Resume (start of every execution session)

1. Read `PROGRESS.md`. Read `PLAN.md` by section, not whole when it is large. Do not read `HISTORY.md` or, outside a deferral pass, the whole of `DEFERRED.md`, and do not read research or reference material yourself; sub-agents read it through packets.
   - Read `DECISIONS.md` as an index: `grep -n -A1 '^## ADR' <run dir>/DECISIONS.md` lists each decision's title with who made it. Open a decision in full when the work at hand touches its subject, and always before you decide something a decision marked `human` covers.
2. Run `git status`, `git log --oneline -15` and `git worktree list`.
   - Each merged task has a commit whose subject starts with `<name> <id>:`. When the task log and git disagree, git wins: correct the log.
   - Uncommitted changes or leftover agent worktrees mean a previous session died mid-task. Send them to a reviewer before spawning new work, then merge or discard them deliberately.
3. Compute the ready set: tasks in the current milestone whose dependencies are all merged and that are not already in flight.

## Model routing

`PLAN.md` holds the routing: which generated agent, model and effort handle each task. The two are chosen separately. The agent follows the kind of work, because that decides what guidance the task needs (see "Run agents" in `PLANNING.md`). The model follows one rule: the cheapest model that can write the work writes it, and the stronger model is spent on reviewing it.

Three roles frame the run's cost:

- **The orchestrator runs on `opus` at `high` effort.** Its context is re-read on every turn of a long session, so its model sets a large part of what a run costs. It keeps the judgment that needs the whole run in view: the requirements, the packets, the decision on each finding, merges, and the conversation with the human.
- **The plan is written on the strongest model available (`fable` today), always.** An error in the plan is repeated in every task built on it, and writing it is one bounded spawn, not a session. The planner is also how the strongest model's understanding reaches every cheaper agent: through the invariants, the interfaces and the checks it writes into the rows.
- **Exploration runs on the cheapest model (`haiku`), at `xhigh` effort.** Locating code and describing what is there needs no strong model, but the planner builds on the notes, and Haiku is the one model that keeps gaining well past `high`. At its price the extra effort costs little; the planner reads the notes and looks up the rest itself.

**Sonnet writes, Opus reviews.** On the same model, writing a task costs about twice what reviewing it does. Every task is reviewed by an `opus` reviewer that did not write it, and every behavior change by another model family as well. That net is what lets a cheaper model write: most of what it gets wrong on a first pass comes back as findings, and a fix round on the cheap model costs little. Defaults for the current Claude models:

| Work | Model | Effort |
|---|---|---|
| Orchestrate (this session) | `opus` | `high` |
| Explore during planning: locate code, map files, collect conventions and commands | `haiku` | `xhigh` |
| Research that needs judgment: compare approaches, read a specification or a design | `sonnet` | `medium` |
| Write the plan; detail a later milestone; a significant plan revision | `fable` | `high` |
| Implement, and fix | `sonnet` | `high` |
| Task review, of a `full` or a `light` task; fix verify; verify a doubted finding; deferral pass | `opus` | `high` |
| Merge a finished counter-review into the findings; check a purely mechanical fix | `sonnet` | `medium` |
| Fidelity and architecture gate lenses | `fable` | `high` |
| Dogfood and runtime gate lenses | `opus` | `high` |

### Escape hatches

A task leaves those defaults only through a hatch. There are two kinds of reason, and they send a stronger model to different places:

- **The task is hard to write.** A cheaper model would get it wrong or badly shaped, and review would catch it. The cost is rework: fix rounds, or a shape later tasks have already copied. The hatch is an **`opus` implementer**.
- **The task is hard to check.** An error would pass its tests and both reviewers, because the tests come from the same reasoning as the code. The cost is a silent failure: lost data, a double charge, a broken access boundary. The hatch is a **`fable` reviewer**, with an `opus` implementer. The strongest model goes to the review because reviewing on it costs about half of implementing on it.

**At plan time** the planner assigns hatches, since it sees the whole design before any code exists. It reaches for them in this order:

1. **Write the check into the row.** State the invariant and the oracle that proves it: the reference values, the crash point after every commit compared with the uninterrupted run, the property that must hold for every input. A task with such an oracle is checkable whoever writes it, and often needs no stronger model at all.
2. **Split or sharpen the row.** A row that seems to need a stronger writer is usually too large or leaves too much open.
3. **Name an `opus` implementer** when the row still cannot be made small or tight enough: it defines an interface or a pattern that several later rows build on, so the shape should be right the first time; it leaves real design decisions to the implementer; or it integrates many units at once.
4. **Name a `fable` reviewer** when the task is of the kind that fails silently: concurrency and idempotency, a security or access boundary, money, deleting or migrating data, a novel algorithm.

Each hatch carries its reason in a clause on the task row, and the plan gives their total. The human sees the list at STOP 0 and approves it with the plan, so what the run spends above the defaults is known before it starts. Hatches the planner adds when it details a later milestone are listed, with reasons and the new total, under "Decisions to report". Hatches are typically a handful per milestone for `opus` and a few per run for `fable`; many more than that means step 1 or 2 was skipped. A `fable` implementer is not a planner's hatch: it happens only when the human names the task.

**At run time** a hatch opens on what the first attempt shows, not on a prediction:

- the first review finds a critical: that round's fixer runs on `opus`. A round has one fixer, on the model its hardest finding needs;
- a fix fails its verify, or an implementer or fixer returns `blocked`: the next fresh agent runs one model up, at the same effort, and no higher than `opus`;
- a critical is still open after two fix rounds on `opus`: one `fable` fixer takes the next round. Its fix gets the cross-model delta review as well as the verify, and a critical it leaves open is a halt for the human.

A spawn that fails without doing its job has shown nothing about the task. An agent that dies on a usage limit, a rate limit or a tooling error is not `blocked`, and its task does not move up a model: run it again on the same model when the limit allows. When the limit will not clear soon, let what is in flight finish, hand off, and tell the human which allowance ran out and when the run can continue.

Nothing else reaches `fable` at run time. A task that still fails on `opus` at `high` without a critical is rescoped, deferred or taken to the human, who may name a stronger model for it. Record a run-time hatch on the round's decision line.

How to use the table:

- **Always name the effort.** The models' own defaults differ (Opus runs at `medium` when none is given, Sonnet and Fable at `high`), so write `model` and `effort` into each generated agent's frontmatter and pass both on every spawn that differs from it. This skill asks for those per-spawn values; follow the plan's table.
- **A reviewer is at least as strong as the work it reviews.** The defaults give that, except for the verify of a `fable` fixer, which the delta review backs. A generated reviewer serves several modes, so its frontmatter carries the task-review default and the other modes are per-spawn overrides.
- **Fixes and their checks are routed by the finding, not the task.** Most findings on a hard task are still small: a missing case, a test that cannot fail, a wrong clock read. A fix starts on `sonnet` whatever wrote the task, unless a run-time hatch applies. A fix verify is a closed question with a stated basis, so it stays on `opus` even for a task with a `fable` reviewer, and drops to `sonnet` at `medium` when every finding in the round is purely mechanical (a rename, a reindent, a moved import). When a fix's reasoning needs a second opinion, that is the cross-model delta review, not a stronger verifier from the same family.
- **The strongest model is usually the scarcest.** On a subscription it has its own, smaller allowance, and a run can exhaust it while the other models have barely been used. It is spent on the plan, the fidelity and architecture lenses, the reviews the plan names, and the rare `fable` fixer. When a `fable` spawn fails on the allowance, or the human says it is short, the named reviews fall back to `opus` first, then the lenses; record each fallback under "Decisions to report". Plan work waits for the allowance, or for the human to name another model.
- **`high` is the floor for implementing, fixing and reviewing.** A model usually loses a good deal between `high` and `medium`. `medium` is for `sonnet` on mechanical work: merging a finished counter-review, checking a rename or a reindent.
- **Raise the model before the effort.** Most of a model's gain arrives by `high`; `xhigh` and `max` cost many more tokens for an uneven gain. Haiku is the exception: it is cheap enough, and gains enough, to explore at `xhigh`. `xhigh` on `opus` or `fable` is the human's to name.
- **Cost scales with the tier.** Per token, Opus costs about twice Sonnet and Fable about twice Opus, and Haiku costs a small fraction of Sonnet.
- **The plan-writing route does not move down.** The plan may adapt every other row. Writing the plan stays on the strongest model.
- **A task that spans domains is split** (see "Run agents" in `PLANNING.md`), as one that mixes levels of difficulty is.
- **Report what the routing bought.** The task log records which model wrote each task and how many fix rounds it took, and each session's report in `HISTORY.md` totals them (see "Context hygiene"). That is how the human, and the planner of the next milestone, learn whether the cheaper writer is holding up or the hatches need to move.

Model names age. When newer models exist, keep the shape (the cheapest model explores, a cheap one writes, a stronger one orchestrates and reviews, the strongest writes the plan, judges each milestone and reviews the rare task whose errors hide) and record the run's mapping in `PLAN.md`.

## Changing the agents mid-run

"Run agents" in `PLANNING.md` describes the run's agents and what makes a kind of work its own domain. A task you add goes to the implementer of the domain its work belongs to, or to the general one.

The run learns what its agents should have been told. When the same finding returns across a domain's tasks, the lesson belongs in that domain's agents: add the line yourself, in the implementer and the reviewer, and record it as the skill's "Who decides" describes. A gate teaches the same way. A critical or major confirmed there is something a task review let through, so add what a task reviewer would have had to look for to that reviewer's lenses, unless the problem could only be seen in several tasks taken together, which is what the gate is for. Adding, removing or re-scoping an agent is a plan revision and goes to a fresh planner, as does a milestone that opens a new domain. Agent definitions load when a session starts, so a new or changed agent takes effect in the next fresh session. Until then, send that work to the general agent with the guidance in its packet.

## Sub-agent contract

**Packet.** Before spawning, write `packets/<id>.md`. Keep it bounded, typically under 25k tokens. It holds:

- the task row;
- the goal and files of each dependency;
- deferred findings this task carries: `grep -n '→ <id>' <run dir>/DEFERRED.md`;
- the plan sections the row cites, and the plan's code-shape entries for the files the task touches;
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
- a sub-agent that waits on a command keeps its cache warm. A slow host or a command whose result the agent genuinely needs can still outlast five minutes, so agents run installs and the task check through this skill's `scripts/wait.sh`. It runs the command in the background and returns after 100 seconds when the command is still running; each return is a small turn that refreshes the cache, and the agent waits again until the command finishes. The wait is that short because Claude Code moves a foreground command to the background after three minutes, or at its two-minute default timeout, and the agent then gets a notice instead of the line to run next. A quick command finishes within the first wait, so agents use it for any command that might take more than a minute. `wait.sh stop <handle>` ends a stuck command together with everything it started. The script also holds a command back while the machine's slots are taken (see "Where tests run"); a `queued` line in the log is that wait, not a stuck command. Generated agents carry the script's absolute path.

## Where tests run

The same tests on the same bytes say the same thing however often they run, and every run takes the machine from the other tasks. So each run of the tests has one owner and one reason:

| Tier | Who runs it | What it runs | When, and where |
|---|---|---|---|
| Task check | the implementer or fixer | the task's own tests: the test files its row names and the ones it wrote or edited, plus typecheck-level checks such as `tsc --noEmit` or `cargo check`, and lint | while it works, in its worktree |
| Merge check | you | the same check, once, over the test files of the tasks you just merged | after the tasks that were in flight together are merged, in this checkout |
| Full validation | you | the full build (a whole-workspace or release compile, a bundle), the full suite and every slow test group | at the session handoff and at a milestone gate, in this checkout |

- **The task check is the task's own tests, not every test near its files.** A command that picks tests by what imports the changed files, such as `vitest related` or `jest --findRelatedTests`, runs most of a suite when a core file changes; the plan's command takes test files by name. The typecheck covers what the task's own tests cannot see: a caller elsewhere that no longer compiles.
- **Reviewers do not repeat the task check.** The implementer ran it on the bytes under review, and its return gives the command, the result and how long it took. A reviewer reads the tests and judges what they prove, which a second run does not show. It runs something only to demonstrate a finding: one test, or a probe of its own in a scratch directory. The run that does not rely on an agent's report is your merge check.
- **The merge check tests what nobody has run.** Tasks in flight together each passed on the base they started from, not on each other. One run over their test files after they merge covers the combination. A failure is a fix task (see below).
- **Full validation is not a per-merge step.** Run it once at the handoff and once at a milestone gate, before the gate lenses, and not between merges. When it fails, attribute the failure by reading it: the failing test, then the task whose files it exercises. Bisect only when that leaves it open, and bisect with the failing tests alone, never the whole suite. The failure is then a fix task.
- **Every one of these goes through `scripts/wait.sh`,** yours included. The script lets only a few commands run at once across every worktree on the machine, two unless `ARCHFLOW_WAIT_SLOTS` says otherwise, and queues the rest. Parallel tasks then cannot overload the host by installing or testing at the same moment. For your own runs, start it as a background call with `ARCHFLOW_WAIT_SLICE` set longer than the command needs, so one notification wakes you when it ends.
- An agent that thinks a build or broader verification is needed says so in NOTES; you decide whether it is worth a run before the handoff.

**A failure after the merge is a fix task.** The code that fails is already on the run branch and its worktree is gone, so the fix is new work. Write a row for it: the failing tests as its acceptance tests, the implementer agent of the task whose change caused the failure, and a review depth by the usual criteria. Run it through the per-task loop to its own commit. A trivial fixup, as step 5 of the loop allows, you may still make in this checkout: commit it on its own and list it in that task's review file as not separately reviewed. Anything larger that you repaired here yourself would be code only its author has read, which is what the loop exists to prevent.

Cost is reviewed like correctness. An implementer reports how long its check took, the task's `verification.txt` passes that to the cross-model test reviewer, and a reviewer treats a test that is slower than what it proves requires, or that repeats another test's protection, as a finding whose suggested fix names the cheaper test or the one to remove. Record how long the full suite took in each handoff. When it has grown out of proportion to what a milestone added, say so in the gate row and make the slowest tests a task.

## Review depth

Each task row carries a `review` depth, approved with the plan at STOP 0:

- **`full`**, the default: the task changes behavior. That covers source code, test logic, schemas, build or CI configuration, and anything that touches a path under an approval rule or a kind of change a constitution trigger names. It gets the in-model review and the cross-model counter-review.
- **`light`**: a mistake in the task is cheap and easy to see. Documentation, comments, wording, formatting, regenerated files, a rename the typecheck proves. It gets the in-model review only. Its cross-model coverage is the milestone counter-review.

Depth follows what the diff does, not what the row expected. Raise a task to `full` whenever you judge it needs it, and always when a `light` task's diff turns out to change behavior; its reviewer says so. Lowering a task that changes behavior is the human's to waive. A task you add mid-run takes its depth from the same criteria.

## Per-task loop

A change gets one open-ended review. A fresh reviewer asked to review again finds something every time, because it has no memory of the round before, so a second open-ended pass over the same work mostly re-judges what the first already judged. After a fix, the question is narrower, and it has an answer: is each finding fixed, and did the fix break anything? Steps 2–5 are the review; step 6 is that check.

1. **Implement.**
   - Spawn the implementer agent the task's row names, in implement mode, with worktree isolation, on `opus` at `high` when the row carries that hatch. Its setup brings the fresh worktree to the base commit you name (`git reset --hard <sha>` is safe in a fresh worktree) and installs dependencies.
   - It writes code and tests, runs the plan's task check on the task's own test files until it passes, reports the command, the result and how long it took, writes `reviews/<id>-impl.md` in its worktree when a fixer or reviewer needs more than its short return or when it found a structural problem that was already there, and never commits.
   - Run tasks in parallel only when their file sets do not overlap: typically a handful at once. `wait.sh` keeps their installs and checks from all running at the same moment, so a batch wider than the machine can check mostly waits in its queue.
2. **Review, once.** When the implementer returns, start the task's reviews together. Other tasks keep moving while they run.
   - Spawn a fresh reviewer: the reviewer agent of the task's domain, which also takes this task's later merge, fix-verify and verify spawns. It runs on `fable` when the row names a `fable` review. Give it the worktree path, the base commit, the packet, the task's review depth, the implementer's `EXTRA` and reported check result, the implementer's notes file `reviews/<id>-impl.md` in the worktree when it wrote one, and the output file `<run dir>/reviews/<id>-r1.md` as an absolute path in this session's checkout. It reviews the diff and its tests against the acceptance criteria by reading them, without repeating the task check, writes its findings table, and returns its verdict without waiting for the counter-review.
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
   - **A `structure` row** is decided the same way, and its knock-on effect is usually the whole question: fix it now when later tasks will build on that shape or copy it, because every one of them then pays for it and a later reorganization touches all of them. A small one goes to the fixer with the task's other findings. One that would reshape code other tasks are working in, or that was there before the task, becomes a task of its own, so the reorganization gets its own review and does not hide inside a behavior change. A run is meant to leave the code better organized than it found it, not only working.
   - **Defer** when it does not matter yet: it is cosmetic, a task that will rework that code anyway is the better place for it, or fixing it now would widen this task's scope. Record why in `DEFERRED.md` (see below).
   - **Dismiss** a finding that is wrong or not worth doing at all, with the reason in the review file.
   - Write each decision as a line under the round's table in the review file: `<row id>: fix | defer → <owner> | dismiss | keep | revert | decided | halt — <reason>`.
   - Fix-now findings go to a **fresh** fixer: a new spawn of the task's implementer agent in fix mode, given the review file, the finding ids, the packet, the worktree path, and the implementer's notes file when there is one. It runs on `sonnet` unless a run-time hatch under "Escape hatches" applies; say which on the decision line. Never resume the implementer for fixes.
   - Before spawning the fixer, record the worktree's current tree, so the fix can be checked on its own: `cd <worktree> && git add -A && git write-tree > <run dir>/packets/<id>-pre-r<k+1>.tree && git reset -q`. When the fixer returns, record the fixed tree the same way into `<id>-post-r<k+1>.tree`.
   - When nothing needs fixing now, the task goes straight to the merge.
   - Deferred findings go into `DEFERRED.md`, one line each with a reason and the task that owns it, and into that task's packet. Name the owner on the line, since that is how the entry is found when the owner starts.
   - You may make trivial fixups yourself, typically 10 lines or fewer, in the worktree. List one made after the review in the task's review file as not separately reviewed. The milestone counter-review is what reads it, so a milestone that holds one runs that review with every role. Anything larger is a fix: it goes to a fixer and gets checked.
6. **Check the fix.** Check what the fixer changed, not the task again.
   - **Always: fix verify.** Spawn a fresh reviewer in fix-verify mode, on `opus`, or on `sonnet` at `medium` when every listed finding is purely mechanical, with the review file, the finding ids sent to the fixer, both tree IDs (the contents of the two `.tree` files), the packet, and the fixer's `EXTRA` and `ORACLE` lines and its reported check result. It appends round `r<k+1>` to the review file. For each finding it says whether the fix resolves it and on what basis:
     - `test`: a test exercises the finding's failure scenario, the fixer saw it fail before the fix and pass after, and its expected values do not come from the fixer's own computation;
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

     Lean toward the delta review for the tasks the plan gives a `fable` reviewer, whenever a fix touches their core logic. Write the row that applied on the round's decision line. When the kind of finding already settles it, run the delta review beside the verifier; otherwise decide from the verifier's result. See "Delta review of a fix" below for how to run one. Its points are merged into round `r<k+1>` by a fresh merge-mode reviewer and decided like any others.
   - **Typically one delta review per task.** Its findings are fixed and verified. Run another only when that fix is again derived logic the verifier cannot confirm.
   - A finding the verifier reports as not resolved, or a regression, goes to another fresh fixer and another fix verify, with fresh tree IDs. A verify can only reopen what it was asked to check, so these rounds end.
   - Default limit: three fix rounds. After that, defer or dismiss what is left that is not critical, or rescope the task. A critical still unresolved is a halt for the human.
7. **Merge.**
   - In the worktree, run `git add -A` and make a scratch commit.
   - In this session's checkout, run `git merge --squash <worktree branch>` (the branch is `git -C <worktree> branch --show-current`).
   - Resolve conflicts that have a mechanical owner (regenerate generated files, take the union of append-only registries). Halt on any conflict that needs judgment. A resolution that changes source by hand is listed in the task's review file like a fixup made after the review.
   - Never use a bare `git stash`: the stash stack is shared with every other worktree and session.
8. **Commit.**
   - One commit per task, subject `<name> <id>: <imperative summary>`. The squash merge has staged the task's changes; add the task's own review files by path (`git add <run dir>/reviews/<id>-*`) and the `PROGRESS.md` tick with any `DEFERRED.md` and `HISTORY.md` lines that go with it, and commit the index. `git add -A` in this checkout would sweep in other in-flight tasks' review files.
   - Tick the task log in `PROGRESS.md`: one line with the short SHA, the review file and its counts. What the review found is told in the review file, not repeated here. Close each deferred finding this task carried, using the reviewer's `carried` rows: one that is fixed leaves `DEFERRED.md` and becomes a `- closed` line in `HISTORY.md` with the SHA; one still open stays, routed to a new owner. The tick can ride along with the next commit.
   - Remove the worktree and its branch once the commit exists: `git worktree remove --force <worktree>`, then `git branch -D <branch>`. The branch needs `-D` because a squash merge leaves it looking unmerged. See "Worktrees and temporary directories".
9. **Merge check.** When the tasks that were in flight together are merged, run the task check once over their test files in this checkout. The full build and suite wait for the handoff or the milestone gate. See "Where tests run".

## Worktrees and temporary directories

The human comes back to this repository long after the run. A worktree, branch or temp directory the run left behind is something they find later and cannot tell is safe to delete, and on a long run these pile up by the dozen. So clean up as each piece of work ends, not at the end of the run:

- **Task worktrees.** Claude Code keeps a sub-agent's worktree and its branch whenever the agent changed anything, so every implemented task leaves one. Remove both as soon as the work is in the run branch or discarded: after the task's commit (step 8 of the per-task loop), and when you discard an attempt or rescope a task.
- **A sweep at handoff and at completion.** Run `git worktree list`, then `git worktree prune`. After the sweep the list holds only work that is still in flight, and the handoff names it. Remove a leftover only when its task's commit is in the run branch or you have decided to discard it; work that is not merged goes through "Resume" first, never out with the sweep. A worktree you cannot tie to this run's tasks may belong to another session: leave it, and tell the human it is there.
- **Scratch review worktrees.** The delta and milestone reviews build theirs under a temp directory named for the run (`archflow-run-<name>.XXXXXX`). Remove the worktree and that directory when the review returns. The name is what lets `scripts/cleanup.sh` find one a dead session left.
- **Everything else outside the repository.** A directory you or a sub-agent makes for an experiment, a log or a downloaded reference is deleted by whoever made it, before that agent returns. `scripts/wait.sh` clears its own handles: each `run` deletes the ones last touched over a day ago.

## Cross-model counter-review

`scripts/counter-review.sh` in this skill directory runs ArchFlow's standalone counter-review (`archflow-local review`) on the directory you give it. Under the routing in the repository's `.archflow/config.yaml` (or ArchFlow's shipped defaults), it dispatches:

- a counter-reviewer from the opposite model family;
- a test reviewer;
- a constitution reviewer when constitution rules exist.

The script's optional fifth argument names a subset of those roles (`counter-reviewer`, `test-reviewer`, `adjudicator` for the constitution reviewer, comma-separated). Omitted, every applicable role runs. A run uses each role where it has something to say:

- **A task's first review runs `counter-reviewer,test-reviewer`.** The test reviewer runs once per task. Once it has reported, do not run it again for that task: its findings are fixed and verified like any others, and the milestone counter-review sees the integrated result.
- **The constitution reviewer runs on the plan and on each milestone's integrated result**, in the plan review and the whole-milestone counter-review, which name no roles. The plan review judges the rules for the whole run, and a task that follows its approved row gives the reviewer nothing new to judge. A trigger that matches therefore reaches you at the gate, for work already merged on the run branch and before any STOP, push or pull request; triage it there as "Human-review reasons" describes.
- **Approval rules do not wait for the gate.** A path under `approval_rules` in `.archflow/config.yaml` is matched on every call whatever roles it names, so a task that touches one still reports it in its own review.
- **Add `adjudicator` to a task's review** when the human asked at STOP 0 to hear about a rule's trigger as each task lands, or when the implementer's `EXTRA` shows a task departing from its approved row in a way a rule is about (access control, secrets, a public contract, database behavior). Record a standing choice in `PLAN.md`.
- A delta review runs `counter-reviewer` alone.
- A role whose dispatch failed has not reported. Retry that role alone.

For a `full` task's first review, write its inputs into `<run dir>/packets/<id>-cr<k>/`, which is gitignored and outside the worktree, without reading the material into your own context:

```bash
out=<run dir>/packets/<id>-cr<k>; mkdir -p "$out"
grep -E '^\| <id> \|' <run dir>/PLAN.md > "$out/ask.txt"   # the task row, acceptance tests included
cat <run dir>/packets/<id>.md <run dir>/BRIEF.md > "$out/plan.txt"
printf '%s\n' "<check command>: <result the implementer or fixer reported>, in <how long it took>" > "$out/verification.txt"
bash <skill dir>/scripts/counter-review.sh <worktree> "$out" claude implementation counter-reviewer,test-reviewer
```

Run the last command in the background; reviews often take several minutes. It prints one status line and writes `result.json`, `summary.json` and `exit` into `$out`. `--producer` is the client running the run (`claude` in Claude Code). The subject is every changed and untracked file in the worktree outside `.archflow/runs/`: the run's own ledger and notes are context for the reviewers, not work under review. The review requires the worktree HEAD to still be the base, which holds because implementers and fixers never commit.

The worktree holds the plan as it was at the base commit, so tell the reviewers what you have decided since. `ask.txt` is read from the current `PLAN.md`, which carries any row you corrected. When you decided to keep unplanned work, or directed work beyond the row in a fix round, add one line saying so to `ask.txt` (`Orchestrator decision: <what is now part of this task, and why>`). Reviewers then judge the work against the decision instead of reporting the difference again.

A nonzero exit is not a pass. An `INPUT_INVALID` error names the input to correct. `SUBJECT_CHANGED` from a review that ran beside a reviewer means something wrote into the worktree meanwhile, usually a test the reviewer ran there: rerun the counter-review on its own. A failed reviewer route may be retried once, naming only that role; if it still fails:

- the task is blocked until the review runs;
- the human may waive it for that task;
- the waiver is recorded in `DECISIONS.md`.

When the installed `archflow-local` has no `review` command, ArchFlow needs reinstalling; tell the human rather than installing it yourself.

### Delta review of a fix

A delta review puts only the fix in front of the cross-model reviewer. The review's subject is whatever differs from `HEAD` in the directory it runs on, so build a scratch worktree whose `HEAD` is the task as it stood before the fixer and whose only change is what the fixer did:

```bash
pre=$(cat <run dir>/packets/<id>-pre-r<k>.tree); post=$(cat <run dir>/packets/<id>-post-r<k>.tree)
c=$(git commit-tree "$pre" -p <base sha> -m "<id> before fix r<k>")
tmp=$(mktemp -d "${TMPDIR:-/tmp}/archflow-run-<name>.XXXXXX"); wt=$tmp/wt; git worktree add -q --detach "$wt" "$c"
git diff --binary "$pre" "$post" | git -C "$wt" apply --index
out=<run dir>/packets/<id>-cr<k>; mkdir -p "$out"
{ grep -E '^\| <id> \|' <run dir>/PLAN.md
  printf '%s\n' "This is a review of a fix, not of the whole task. The baseline already holds the task's reviewed work; the subject is only what the fixer changed." \
    "Findings being fixed: <each id with its claim>." \
    "Judge whether each fix is correct and complete, and whether it breaks anything." \
    "Already decided, not to be reopened: <deferred and dismissed rows, and your decisions on unplanned work>."; } > "$out/ask.txt"
cat <run dir>/packets/<id>.md <run dir>/BRIEF.md > "$out/plan.txt"
printf '%s\n' "<check command>: <result the fixer reported>, in <how long it took>" > "$out/verification.txt"
bash <skill dir>/scripts/counter-review.sh "$wt" "$out" claude implementation counter-reviewer
```

Remove the scratch worktree and its directory afterwards with `git worktree remove --force "$wt"; rm -rf "$tmp"`. The scratch commit is on no branch and needs no cleanup. Because the review reads its own worktree, it can run while the verifier works in the task's worktree.

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
start=<milestone start sha>; tmp=$(mktemp -d "${TMPDIR:-/tmp}/archflow-run-<name>.XXXXXX"); wt=$tmp/wt
git worktree add -q --detach "$wt" "$start"
git diff --binary "$start" HEAD -- . ':!.archflow/runs' | git -C "$wt" apply --index
```

Then run the script on `$wt` with `implementation` as the stage. `ask.txt` holds the milestone's goal and its task rows, `plan.txt` the plan's architecture and invariants plus `BRIEF.md`, and `verification.txt` the full build and suite result, how long the suite took, and its slowest test files when the runner reports them. Remove the worktree and its directory afterwards with `git worktree remove --force "$wt"; rm -rf "$tmp"`. A milestone over the review's 25 MiB snapshot limit is reviewed per lane instead.

## Milestones and gates

A milestone ends with full validation (see "Where tests run") and then the gate lenses `PLAN.md` declares, which judge a result already known to build and pass instead of running the suite again. A useful default set, each lens a fresh reviewer run in parallel:

- **fidelity:** the result against the reference and the requirements. It goes through the requirements the milestone was to meet one by one and names the evidence for each: a test, a behavior it observed, or nothing;
- **architecture:** drift from the plan's architecture, shortcuts that force rework, and the shape of the milestone's code taken together: responsibilities that spread across tasks, units that grew past one job as several tasks added to them, the same state or rule now owned in two places, patterns that diverged between lanes. The task reviews see one diff each; this lens is where the sum is judged, and what it finds becomes cleanup tasks. Give it a bounded reading list: the plan's code shape, the milestone's diff stat, the files that changed most, the milestone's `structure` rows, and what implementers noted as already there (the `## Already there` sections of the milestone's `reviews/*-impl.md`), not the whole codebase;
- **dogfood:** use the result the way its consumer will, and report the friction;
- **runtime:** run it end to end.

The plan chooses each gate's lenses, with one exception: the last milestone always runs fidelity, over every requirement in the plan, and runtime. A run does not report done for something nobody ran end to end and checked against what was asked. When the result cannot be run in this environment, the final report says what was not run and why.

Run the whole-milestone counter-review as well, with every role. It is the cross-model coverage for `light` tasks, for fixes that were only verified, and for how the tasks fit together. It is where the test reviewer sees the integrated result, and it is the constitution review of the milestone's work, which the task reviews did not run. For a small milestone whose tasks were all `full`, whose fixes were small, and that holds no change only you have read (a fixup made after a task's review, a conflict resolved by hand), narrow it to `adjudicator` alone instead of skipping it, and say so in the gate row; skip it entirely only when every task of the milestone already ran the constitution reviewer.

Verdict: PASS, PASS-WITH-DEFERRALS, or FAIL. Any confirmed critical is a FAIL. A FAIL produces fix tasks, each with a review depth by the usual criteria. The one-review rule holds here too: a failed lens re-runs only to check that its own findings are fixed, and the milestone counter-review is not run again. The fix tasks a gate produces are covered by the next milestone's counter-review; after the last milestone, run `adjudicator` once over them before the final STOP. Decide a gate's lesser findings the way the per-task loop does: one with knock-on effects for the next milestone becomes a fix task now. What its confirmed criticals and majors teach goes into the reviewers' lenses (see "Changing the agents mid-run").

Record a gate row in `PROGRESS.md`. A gate is not a STOP unless the plan declares one there, so do not stop to report it: the human is not watching mid-run. Include the gate's result in the next message that ends a turn, whether a STOP report, a halt, or the session handoff.

## Deferral pass

Deferring is a decision to revisit, not to forget. At each milestone end, after the gate, read `DEFERRED.md` whole and go over every entry. This pass is what catches an entry its owner never picked up, so it is the one time the whole list is read:

- **Fix:** it matters now. The milestone's work may have raised its cost, or its owner never picked it up. Make it a fix task, or add it to an upcoming task's goal.
- **Carry:** it still does not matter yet and a later task owns it. Confirm the owner exists in the plan.
- **Close:** it no longer applies, or it is not worth fixing. Move it out of `DEFERRED.md` into `HISTORY.md` as a `- closed` line with a reason: already fixed, obsolete, or won't fix because of what it would cost.

When the list is long, or you are not sure an entry still applies, send it to a fresh reviewer in deferral mode, which checks each entry against the current code and recommends one of the three. You decide.

At the last milestone nothing can carry. Every open entry is fixed or closed before the final STOP. The final STOP report lists each won't-fix with its reason, so the human can overturn any of them; `grep -n "won't fix" <run dir>/HISTORY.md` finds them.

When the next milestone is "detailed at start":

- have a fresh planner write its task rows from what the run has learned, each with its review depth (see "Planning agents" in `PLANNING.md`); you do not write them yourself;
- review them once, with the plan-stage counter-review, `counter-reviewer` alone, before spawning any of them. Another model family reading rows the strongest model wrote adds more than a second pass on that model would, and spends none of its allowance;
- the rows need no human gate unless the milestone changes the requirements or a decision the human made;
- fix supported findings;
- record the result in `PROGRESS.md`.

## Findings format

Reviewers write one table per round:

```
| id | severity | source | file:line | claim | failure scenario | suggested fix |
```

- `source` says where the row came from:
  - `self`, `counter`, `tests`, `constitution`: a finding from that reviewer. A structure point from the counter-reviewer alone keeps source `counter` and starts its claim with `Structure:`; it is `structure+counter` only when the in-model structure pass made the same point. A point two reviewers raised independently is one row naming both, such as `self+counter`: agreement between model families is strong evidence, and a `counter` row the in-model reviewer missed marks where that family may be blind;
  - `structure`: the in-model reviewer's judgment of how the task leaves the code organized: a unit that now does two jobs, state or a rule kept in two places, a parallel pattern. The claim names what it costs the next change, and the suggested fix is the smallest reorganization that removes it;
  - `carried`: the deferred findings this task was meant to pick up. Those that are fixed share one row, which names each with its evidence; one still open, or only partly fixed, gets its own row at its original severity;
  - `unplanned`: work in the diff that the task row did not ask for. Sound work the reviewer would keep shares one row, an item to a clause. An item gets its own row only when the reviewer recommends `trim` or `revert`, when keeping it changes what a task row, a criterion or the architecture says, or when it has a concrete consequence;
  - `human-review`: a counter-review `human_review_reasons` entry, quoted in the claim, with the reviewer's check of whether the change it names is really in the diff.
- The column holds one of those values and nothing else, or two reviewer sources joined with `+`. A plan that adds a row kind of its own names its value. Anything more about where a row came from goes in the claim, so the run can later count what each reviewer found.
- Every row is one you decide and one you read on every later turn, so a reviewer writes a row only for something that needs a decision. What is merely true of the diff goes in the review's prose.
- The suggested fix must be concrete enough for a fixer with no other context.
- When a finding has knock-on effects, such as later tasks building on it or a pattern others will copy, the failure scenario says so. That is what decides fix now or defer.
- Every material counter-review point is in the table, as its own row or folded into the row it matches. A reviewer that disagrees with one keeps the row and gives its evidence; you decide.
- A fix-verify round starts with its own table, `| id | resolved | basis | evidence |`, one row per finding sent to the fixer, followed by a findings table only when the fix caused a regression.

Severity:

- **critical:** wrong behavior or a crash in scope, a broken build or broken tests, an invariant violation, or a departure from the architecture that breaks something or that later tasks would build on wrongly;
- **major:** a missing acceptance criterion, a fidelity error against the reference, missing tests for core behavior, or a `structure` problem later tasks will build on;
- **minor:** every other defect;
- **note:** not a defect, but a row you need to decide: sound unplanned work, a human-review reason, or a criterion or plan detail that the code shows to be wrong. Notes are not counted in the verdict.

Work is judged by what it does, not by whether the plan mentioned it. Doing more than the row asked, or departing from a plan detail in a way that works, is a `note` for you to decide. It becomes a finding only through a concrete consequence.

## Task sizing and the plan table

Agent cost grows faster than linearly with the length of the task. Keep each task reviewable in one pass. A typical ceiling is about 600 changed lines; split larger rows into `a`/`b` rows in `PLAN.md` before spawning, and commit the split on its own.

Task table columns:

```
| id | goal | files | acceptance tests | depends on | size | agent | review | lane |
```

- **Agent** names the generated implementer agent that takes the task (see "Run agents" in `PLANNING.md`), followed by `opus/high` and the reason when the task has that hatch (see "Escape hatches").
- **Review** is the task's depth, `full` or `light` (see "Review depth"), followed by `fable` review and the reason when the task has that hatch.
- **Acceptance tests** name the test file and list concrete assertions. For a task whose errors would otherwise hide, they carry the oracle: the invariant, and the check that proves it.
- **Dependencies**: `Tn` is a hard edge; `Tn (soft)` is a preference.
- **Lanes** group tasks that touch disjoint files, so they can run in parallel.
- **Carry-overs**: deferred findings a task must pick up are appended to its goal, citing their review id.

**Rows you write.** The planner writes the plan's rows. You write a row only for work the run has already shown to be needed: a finding, a failed check, a deferred finding, a cleanup a `structure` row asked for, or a split of an existing row. Carry that evidence into the row, so it has its oracle: the acceptance tests are the failure scenario or the failing test, and the agent and review depth follow the usual criteria. Work that adds behavior or an interface the plan does not hold is a plan revision, and goes to a fresh planner.

## Context hygiene

The orchestrator's cost per turn grows with its context:

- Hand off after a batch, typically 8–10 merged tasks, or earlier when the context grows heavy.
- Prefer `grep -n` and bounded windows for large files, or delegate them.
- Query JSON with `jq`.
- Pipe long output through `tail`.
- Let completion notifications wake you instead of polling.

At a handoff, run full validation, sweep the worktrees and temporary directories this session's finished work left behind ("Worktrees and temporary directories"), write the handoff, and commit.

A handoff has two parts, because the next session and the record need different things.

What the next session acts on replaces "Resume here" in `PROGRESS.md`; it is rewritten, not added to:

- anything in flight;
- what the next session must know to run things, such as a local stack that is up or a path that changes per session;
- the carry-over items the next tasks must take, when `DEFERRED.md` does not already hold them;
- a "Next" list.

What the session did is appended to `HISTORY.md` as its report:

- tasks merged, as a count of done over total;
- the merge checks and the full validation result, with how long the suite took;
- what the routing bought: for each model that wrote tasks this session, how many it wrote, the findings their reviews raised by severity (structure rows counted apart: source `structure`, or a claim that starts `Structure:`), the fix rounds they took, and each run-time hatch with the task it opened on;
- decisions made, each with how to undo it.

A handoff leaves `PROGRESS.md` holding only live state. When it holds more, move that text out with a shell command (`sed`, `awk`) instead of retyping it, since text you retype is paid for again as output: earlier sessions' reports and closed findings go to `HISTORY.md`, and a list of open deferred findings goes to `DEFERRED.md`. Create either file from its template when the run does not have it yet.

The report is also what the human reads, so the closing message of the session summarizes both parts in plain language rather than pointing at the files, and ends with the exact command that starts the next session, on the orchestrator's model and effort.

## Decisions to report

A call you make on the human's behalf gets one line under "Decisions to report" in `PROGRESS.md` when you make it: what you decided in plain words, why, and how to undo it. That covers unplanned work you kept or reverted beyond a small necessary fix, a task row, criterion or architecture detail you corrected, tasks you added or dropped, and each human-review reason you decided yourself. Routine keeps can share one line per task. The next message that ends a turn reports them all, whether it is a handoff, a STOP report or a halt, and the entries then move into that session's report in `HISTORY.md`. A fresh session reports whatever is still listed.

## Halts

Halt only for a decision the skill's trust boundaries give to the human; everything else is decided and reported. A halt between STOPs follows the skill's "Talking to the human". Finish or park what is in flight first: let running agents return and record their results, so the question you ask reflects the whole state and the human's answer is not overtaken by a late result. Other tasks that do not depend on the answer keep going until they are merged; halt when only the blocked work is left, or straight away when the question affects everything. Write the question under "Waiting on the human" in `PROGRESS.md`, set `AWAITING USER (halt)`, commit, and ask once, with everything open in one message.
