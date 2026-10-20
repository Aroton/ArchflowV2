# Run protocol

This is the working procedure for `/archflow-run`. The skill's trust boundaries are the hard rules. Everything here is a calibrated default: adapt it to the work, and record material changes in the run's `DECISIONS.md`.

A run's state lives in its files and in git, not in any session's context. Any fresh session can pick up where the last one stopped.

## Run files

```
.archflow/runs/<name>/
  PLAN.md          requirements, architecture, invariants, commands, routing, milestones, task table, STOPs
  PROGRESS.md      status line, milestone board, task log, deferred findings, gate log, session handoffs
  DECISIONS.md     ADR log: ## ADR-NNN <title> (status, context, decision, consequences)
  BRIEF.md         the reference-and-validation brief every counter-review receives
  research/        persisted research later sessions need (optional)
  packets/         per-task context packets (gitignored, regenerated on demand)
  reviews/         <id>-impl.md, <id>-r<k>.md, gate-<milestone>-<lens>.md, STOP-<n>-report.md
.claude/agents/<name>-<role>.md   generated run agents (Claude Code)
```

`PROGRESS.md` starts with one status line:

```
**STATUS: PLANNING | AWAITING USER (STOP n) | RUNNING | COMPLETE**
```

Follow it with one sentence on where to resume.

## Resume (start of every execution session)

1. Read `PROGRESS.md` and `DECISIONS.md`. Read `PLAN.md` by section, not whole when it is large. Do not read research or reference material yourself; sub-agents read it through packets.
2. Run `git status` and `git log --oneline -15`.
   - Each merged task has a commit whose subject starts with `<name> <id>:`. When the task log and git disagree, git wins: correct the log.
   - Uncommitted changes or leftover agent worktrees mean a previous session died mid-task. Send them to a reviewer before spawning new work, then merge or discard them deliberately.
3. Compute the ready set: tasks in the current milestone whose dependencies are all merged and that are not already in flight.

## Model routing

`PLAN.md` holds the routing table: which generated agent, model and effort handle each kind of task. Spend capability where errors are expensive and costly to detect:

- core, algorithmic, or correctness-critical work goes to the strongest model;
- plumbing, registries, and mechanical changes go to a cheaper one;
- reviews of correctness-critical work go to the strongest model.

Per-spawn `model` or `effort` overrides follow the table. If a task mixes kinds, split it, or route it to the more demanding kind.

## Sub-agent contract

**Packet.** Before spawning, write `packets/<id>.md`. Keep it bounded, typically under 25k tokens. It holds:

- the task row;
- the goal and files of each dependency;
- deferred findings this task carries;
- the plan sections the row cites;
- any external reference material the agent needs verbatim.

Agent sandboxes may not reach the network, so fetch references into the packet instead of trusting an agent to fetch them. Agents read the packet instead of the design documents.

**Prompt.** Pass the packet's absolute path, because worktrees do not contain the gitignored packet directory. Also pass the base commit, any extra task-specific pointers, and the exact output paths. The generated agent definition already carries the standing guidance, the context-budget rules and the return format, so a prompt is typically 20–40 lines.

**Return format.** Every agent ends with a short block, typically 15 lines or fewer, and writes anything longer to its output file:

```
STATUS: done | blocked | needs-decision
FILES: <written/changed paths>
VERDICT: <one line; reviewers: PASS | FIXES-NEEDED (n critical, n major, n minor)>
NOTES: <≤3 bullets>
QUESTIONS: <only if blocked/needs-decision>
```

`needs-decision` means the agent would have to deviate from an accepted decision or from the requirements. Settle it from `DECISIONS.md` if you can. Otherwise this is a halt for the human. Either way, the answer goes to a fresh agent, never back to the one that asked.

**Never resume an idle agent.** A sub-agent's prompt cache lasts about five minutes. An agent resumed or messaged after that re-reads its whole context uncached, which typically costs more than a fresh agent reading one packet and one review file. So:

- every spawn is a fresh agent that finishes its job in one go and returns;
- fixes go to a fresh fixer, re-reviews to a fresh reviewer, and decisions to a fresh agent with the decision in its prompt;
- no sub-agent step waits on long work. The orchestrator runs the counter-review itself and spawns the reviewer once the result exists. The orchestrator is the one session that waits, and its own cache outlives a typical review.

## Per-task loop

1. **Implement.**
   - Spawn the routed implementer with worktree isolation. Its setup brings the fresh worktree to the base commit you name (`git reset --hard <sha>` is safe in a fresh worktree) and installs dependencies.
   - It writes code and tests, runs the plan's agent check command until it passes, writes `reviews/<id>-impl.md` in its worktree when a fixer or reviewer needs more than its short return, and never commits.
   - Run tasks in parallel only when their file sets do not overlap: typically a handful at once, limited by machine load more than by the model.
2. **Counter-review.** When the implementer returns, run the cross-model counter-review on its worktree yourself, in the background (see below). Other tasks keep moving while it runs.
3. **Review.**
   - When the counter-review finishes, spawn a fresh routed reviewer. Give it the worktree path, the base commit, the packet, the counter-review's `summary.json`, and the output file `<run dir>/reviews/<id>-r1.md` as an absolute path in this session's checkout.
   - It runs the check command, reviews the diff against the acceptance criteria, and writes one findings table that merges its own findings with the counter-review's, then returns its verdict. Read only the verdict line and the table: `grep '^|' <review>`.
4. **Verify (optional).** When you doubt a critical or major finding, send it to a fresh reviewer whose job is to disprove it, ideally with a minimal test. It marks each finding CONFIRMED or REJECTED. Batch doubted findings into one verifier.
5. **Fix.**
   - Confirmed criticals go to a **fresh** fixer, given the review file, the finding ids, the packet and the worktree path. Never resume the implementer for fixes.
   - Before spawning the fixer, record the worktree's current tree so the re-review can isolate the fixer's changes: `cd <worktree> && git add -A && git write-tree > <run dir>/packets/<id>-pre-r<k+1>.tree && git reset -q`.
   - When the fixer returns, run the counter-review again, then spawn a fresh reviewer in fix-review mode with that tree and the new summary. It appends to the review file as round `r<k+1>`. Default limit: three rounds. After that, accept, rescope, or halt for the human.
   - Without criticals there is no fix round. Majors and minors go under "Deferred" in `PROGRESS.md`, each routed to the task that picks it up, and into that task's packet.
   - You may make trivial fixups yourself, typically 10 lines or fewer, in the worktree before its last counter-review, so it covers them. A fixup after the last review is listed in the task's review file as unreviewed, and anything beyond formatting gets another round.
6. **Merge.**
   - In the worktree, run `git add -A` and make a scratch commit.
   - In this session's checkout, run `git merge --squash <worktree branch>` (the branch is `git -C <worktree> branch --show-current`).
   - Resolve conflicts that have a mechanical owner (regenerate generated files, take the union of append-only registries). Halt on any conflict that needs judgment.
   - Never use a bare `git stash`: the stash stack is shared with every other worktree and session.
7. **Commit.**
   - One commit per task, subject `<name> <id>: <imperative summary>`. The squash merge has staged the task's changes; add the task's own review files by path (`git add <run dir>/reviews/<id>-*`) and the `PROGRESS.md` tick, and commit the index. `git add -A` in this checkout would sweep in other in-flight tasks' review files.
   - Tick the task log in `PROGRESS.md` with the short SHA and the review summary. The tick can ride along with the next commit.
   - Remove the worktree and its branch.
8. **Full suite.** Run it once per batch, serialized, not once per merge. Agents running it in parallel overload the machine. Bisect a failure by task and send it to a fresh fixer.

## Cross-model counter-review

`scripts/counter-review.sh` in this skill directory runs ArchFlow's standalone counter-review (`archflow-local review`) on the directory you give it. Under the routing in the repository's `.archflow/config.yaml` (or ArchFlow's shipped defaults), it dispatches:

- a counter-reviewer from the opposite model family;
- a test reviewer;
- a constitution reviewer when constitution rules exist.

For a task, write its inputs into `<run dir>/packets/<id>-cr<k>/`, which is gitignored and outside the worktree, without reading the material into your own context:

```bash
out=<run dir>/packets/<id>-cr<k>; mkdir -p "$out"
grep -E '^\| <id> \|' <run dir>/PLAN.md > "$out/ask.txt"   # the task row, acceptance tests included
cat <run dir>/packets/<id>.md <run dir>/BRIEF.md > "$out/plan.txt"
printf '%s\n' "<check command>: <result the implementer or fixer reported>" > "$out/verification.txt"
bash <skill dir>/scripts/counter-review.sh <worktree> "$out" claude implementation
```

Run the last command in the background; reviews often take several minutes. It prints one status line and writes `result.json`, `summary.json` and `exit` into `$out`. `--producer` is the client running the run (`claude` in Claude Code). The subject is every changed and untracked file in the worktree. The review requires the worktree HEAD to still be the base, which holds because implementers and fixers never commit.

A nonzero exit is not a pass. An `INPUT_INVALID` error names the input to correct. A failed reviewer route may be retried once; if it still fails:

- the task is blocked until the review runs;
- the human may waive it for that task;
- the waiver is recorded in `DECISIONS.md`.

Any returned `human_review_reasons` entry is a halt for the human. When the installed `archflow-local` has no `review` command, ArchFlow needs reinstalling; tell the human rather than installing it yourself.

The plan stage uses the same script with `plan` as the stage, run on the repository root, with `ask.txt` holding the human's ask and `plan.txt` the plan plus each generated agent's standing guidance.

A review of the repository root covers every changed and untracked file in this checkout, so run one only when nothing is writing into it: before spawning tasks, or between batches. Agent worktrees nested in the checkout are skipped.

Task worktrees read `.archflow/config.yaml` and the constitution from the committed tree. Commit any change to them before spawning tasks, or task reviews use different routes and policy than the plan review did.

For a whole-milestone counter-review, keep the run's own ledger and review files out of the subject:

```bash
start=<milestone start sha>; wt=$(mktemp -d)/wt
git worktree add -q --detach "$wt" "$start"
git diff --binary "$start" HEAD -- . ':!.archflow/runs' | git -C "$wt" apply --index
```

Then run the script on `$wt` with `implementation` as the stage. `ask.txt` holds the milestone's goal and its task rows, `plan.txt` the plan's architecture and invariants plus `BRIEF.md`, and `verification.txt` the full-suite result. Remove the worktree afterwards with `git worktree remove --force "$wt"`. A milestone over the review's 25 MiB snapshot limit is reviewed per lane instead.

## Milestones and gates

A milestone ends with the gate lenses `PLAN.md` declares. A useful default set, each lens a fresh reviewer run in parallel:

- **fidelity:** the result against the reference or requirements;
- **architecture:** drift from the plan's architecture, and shortcuts that force rework;
- **dogfood:** use the result the way its consumer will, and report the friction;
- **runtime:** run it end to end.

Add the whole-milestone counter-review when the milestone is large or risky.

Verdict: PASS, PASS-WITH-DEFERRALS, or FAIL. Any confirmed critical is a FAIL. A FAIL produces fix tasks, and then only the failed lens re-runs.

Record a gate row in `PROGRESS.md` and give the human a short summary in chat. A gate is not a STOP unless the plan declares one there.

When the next milestone is "detailed at start":

- write its task rows from what the run has learned;
- counter-review them with `stage:"plan"`;
- fix supported findings;
- record the result in `PROGRESS.md`.

## Findings format

Reviewers write one table per round:

```
| id | severity | source | file:line | claim | failure scenario | suggested fix |
```

- `source` is `self`, `counter`, `tests`, or `constitution`.
- The suggested fix must be concrete enough for a fixer with no other context.
- Every material counter-review point gets a row. A reviewer that disagrees with one keeps the row and gives its evidence; you decide.

Severity:

- **critical:** wrong behavior or a crash in scope, a broken build or broken tests, an invariant violation, or a deviation from the architecture;
- **major:** a missing acceptance criterion, a fidelity error against the reference, or missing tests for core behavior;
- **minor:** everything else.

## Task sizing and the plan table

Agent cost grows faster than linearly with the length of the task. Keep each task reviewable in one pass. A typical ceiling is about 600 changed lines; split larger rows into `a`/`b` rows in `PLAN.md` before spawning, and commit the split on its own.

Task table columns:

```
| id | goal | files | acceptance tests | depends on | size | agent | lane |
```

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
- decisions made;
- the carry-over items the next tasks must take;
- a "Next" list.
