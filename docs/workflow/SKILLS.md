# workflow/SKILLS

**Explored:** 2026-11-11 · **Commit:** `f1fe689` · **Covers:** `skills/`, `src/init/`, `src/local/`, `assets/constitution/`, `skills/archflow-run/scripts/counter-review.sh`

ArchFlow ships four skills. Each is a short, portable instruction file (the Agent Skills format) in `skills/`, and the installer copies the same set into Claude Code, Codex and Antigravity. Skills do not carry workflow state or talk to a server: the only program behind them is `archflow-local` ([COMMANDS](../cli/COMMANDS.md)), and the only durable state is ordinary files in the repository and Git.

| Skill | Purpose |
| --- | --- |
| `archflow-init` | Scaffold the files `archflow-local review` reads and clean up registrations older versions left behind |
| `archflow-constitution` | Explain and edit the repository's constitution rules |
| `archflow-explore` | Produce or refresh the maintained `docs/` set |
| `archflow-run <name> [ask]` | Plan a large job once, then orchestrate it across fresh sessions with sub-agents, worktrees and cross-model review |

Claude Code and Antigravity invoke skills with `/` (`/archflow-init`); Codex uses `$` (`$archflow-init`). `archflow-run` is installed for every client but needs Claude Code as the orchestrator, because it generates `.claude/agents` and spawns worktree-isolated sub-agents; in another client it says so and stops.

```mermaid
flowchart LR
    I["archflow-init"] -->|archflow-local init| F[".archflow/config.yaml<br/>.archflow/constitution/"]
    K["archflow-constitution"] -->|edits rules| F
    R["archflow-run"] -->|counter-review.sh| L["archflow-local review"]
    F -->|read on every review| L
    E["archflow-explore"] -->|writes| D["docs/"]
```

## archflow-init

Runs `archflow-local init` from the repository root. It scaffolds `.archflow/config.yaml` (reviewer routing and approval rules), `.archflow/constitution/` (the repository's policy rules) and `.archflow/.gitignore`, removes the MCP registrations earlier versions of init wrote, and reports diagnostics: the Node version, whether the Claude and Codex CLIs are installed and logged in, and whether an ancestor Git ignore rule hides the generated files.

The skill explains the outcome in plain language. It refuses to overstate the isolation of reviewers (the diagnostics themselves say it is best-effort), never edits the project's own `.gitignore` (it asks the human to add exceptions instead), and treats a `scaffold-diverged` refusal as a question for the human: keep the repository's files, or re-run with `--force`. Invoking the skill authorizes scaffolding the shipped defaults, removing the legacy registrations init reports, and committing the resulting repository files; the skill performs that commit itself after the checks pass. When the human asks how reviewers are routed, it explains the `roles` and `producers` sections of the config and points at the commented example in the template.

## archflow-constitution

Explains and maintains the rules in `.archflow/constitution/`. The constitution is repository-owned policy for human trust boundaries and durable engineering constraints; it is not a style guide, a task checklist, or a way to compensate for a model's current weaknesses.

An explanation request edits nothing. A request to add or change a rule authorizes the scoped edit and its commit. The skill reads the existing rules first and works out the effective set after custom replacements; puts new rules and default replacements in `custom/` under an unused two-digit prefix; keeps each rule one independently reviewable policy with a stable kebab-case `id`; raises the `version` when contents change; and deprecates rather than deletes. It adds a `review_trigger` only when the repository genuinely wants a human decision whenever a condition appears, and the trigger must be something a reviewer can observe in the plan, the changed files or the repository, not a process fact such as who approved what. It names `enforced_by` only for mechanical checks that exist. It validates the whole rule set after editing and shows the diff and its practical effect on review. Refreshing shipped defaults is a separate, explicit `archflow-local init --force`; a rule edit never authorizes it.

It also says out loud, before changing them, that the rules about explicit human authority and a truthful plan, and the rule that guards the policy files, exist to keep a human in the loop. How rules are judged is on the [counter-review page](../review/COUNTER-REVIEW.md#the-constitution).

## archflow-explore

Produces or refreshes the maintained documentation set (this directory): caps-named pages, each with a stamp of date, commit and covered paths. In refresh mode it diffs each page's covered paths since its stamped commit and re-explores only the pages whose code changed, plus any focus area the user names. It may delegate large explorations to parallel sub-agents with complete briefs, reviews the pages against the code, checks links and stamps, and commits the documentation without another approval. It also makes sure the target repository's `CLAUDE.md` lists the pages and states the rule that a change altering behavior a page describes must update that page.

## archflow-run

The orchestrated workflow, for large jobs ("port this system", "build these fifty tasks") where approving each step would cost more than it is worth and one long session would run out of context. The run lives in `.archflow/runs/<name>/`: `PLAN.md` (requirements, architecture, invariants, commands, model routing, milestones, task table, declared STOPs), `PROGRESS.md` (a status line, task log, deferred findings, handoffs), `DECISIONS.md`, `BRIEF.md`, `reviews/`, and a gitignored `packets/`. Git is the record of what merged, and where the ledger and git disagree, git wins.

```mermaid
flowchart LR
  X["Cheap explorers map the repository"] --> P["Planner on the strongest model<br/>writes the plan + run agents"]
  P --> R0["Cross-model plan review"]
  R0 --> S0{"STOP 0: human approves"}
  S0 --> B["Batch: packet, implementer in a worktree,<br/>one review: reviewer + cross-model review,<br/>decide findings, fixer, verify the fix,<br/>squash-merge, commit"]
  B -->|"about 8-10 tasks"| H["Handoff in PROGRESS.md, fresh session"]
  H --> B
  B --> G["Milestone gate lenses + whole-milestone<br/>counter-review, deferral pass"]
  G -->|declared STOP| S1{"Human STOP"}
  G --> B
```

**Why markdown instead of a server.** A strong orchestrator follows a written protocol reliably, and resuming needs only an honest ledger and the commit history. The trust boundaries a human needs are plain rules in the skill:

- the plan is approved before any code, and with it the review depth of every task;
- the plan is written by a planner sub-agent on the strongest model, never by the orchestrating session;
- declared STOPs end the session until the human answers;
- the run halts between STOPs only for a decision that is the human's: a change to what they get, reversing a decision they made, a risky change the plan does not cover, a kind of change the repository's rules ask a human to see, an unresolved critical finding, or an irreversible or outward-facing action;
- every other decision is the orchestrator's, and none is hidden: each is recorded with how to undo it and reported in the next message that ends a turn;
- commits stay local;
- the human is assumed not to be watching. Every message that ends a turn stands on its own: it opens with where the run stands, and it restates each open question in full, with the choices and a recommendation, instead of pointing back at an earlier message. A halt between STOPs is also written into `PROGRESS.md` with the status `AWAITING USER (halt)`, so a fresh session can ask again in full. Results that are not a reason to stop, such as a milestone gate verdict, ride along in the next closing message.

Everything else in the skill and its `PROTOCOL.md` is a default whose numbers (batch size, fix rounds, task size) can be adapted and recorded in `DECISIONS.md`.

**Why review is the part that stays tooled.** ArchFlow's counter-review is what this workflow lacked when it was run by hand. Routing, snapshot views and structured reports are worth reusing rather than re-prompting. When an implementer returns, the orchestrator runs `archflow-local review` on its worktree through `scripts/counter-review.sh` ([COMMANDS](../cli/COMMANDS.md#how-to-treat-the-result) describes the script). That dispatches the opposite-family counter-reviewer, the test reviewer and the constitution reviewer. At the same moment the orchestrator spawns a fresh reviewer sub-agent, which does its own acceptance check without waiting for the counter-review. When both finish, another fresh reviewer, in merge mode, folds the counter-review into the same findings table: a point both reviewers made becomes one row naming both, since agreement between model families is strong evidence. A counter-review that cannot run blocks the merge; it is never replaced by self-review.

**Why a change is reviewed once.** The first version of this loop sent a task back through every reviewer after every fix, and it did not converge. A fresh reviewer has no memory of the previous round, so it does not confirm fixes: it reviews from scratch, and on any nontrivial diff it finds something. Each re-review also received the whole task diff rather than the fix, so it re-judged code already judged, and each fix added new code for the next round to object to. The loop ended at its round cap, not at a clean review, and it spent two opposite-family dispatches per round. So the open-ended question, "what is wrong with this?", is now asked once per change, by two model families at the same time. After a fix the question is closed: is each finding fixed, and did the fix break anything?

```mermaid
flowchart TD
  I["Implement"] --> R["One review: in-model reviewer<br/>+ cross-model pass"]
  R --> D{"Anything to fix now?"}
  D -->|no| M["Merge and commit"]
  D -->|yes| F["Fresh fixer"]
  F --> V["Fix verify: closed check<br/>of the fix, in-model"]
  V --> H{"Can the fix be checked against<br/>something the fixer did not produce?"}
  H -->|"yes: a test with independent values, or the reference"| OK{"Resolved?"}
  H -->|"no: new derived logic, a rework, or a finding the in-model reviewer missed"| X["Delta review: cross-model,<br/>the fix alone"]
  X --> OK
  OK -->|yes| M
  OK -->|no| F
```

A fresh in-model reviewer does the fix verify. For each finding it says whether the fix resolves it and on what basis: a test whose expected values the fixer did not compute, a comparison with the run's reference, or reading alone. It can reopen only what it was asked to check, so fix rounds end.

**Why some fixes still get a cross-model look.** An in-model verifier is reliable on "does the code now do what the finding asked". It is unreliable on "is this new reasoning right", because it comes from the same model family as the fixer and tends to repeat the fixer's mistake. A test does not help when the fixer computed its expected values from the same reasoning. So a fix gets a cross-model delta review when it adds or replaces derived logic (a formula, a numerical method, an algorithm, an ordering or concurrency argument, a parser, a security check) that could be confirmed only by reading; when it fixes a correctness finding that only the opposite family caught, which marks a blind spot in the family doing the verifying; or when it is a rework rather than a patch. The delta review runs the counter-reviewer alone on a scratch worktree whose baseline is the task as it stood before the fixer, so the subject is the fix and nothing else. It is one small dispatch, where the old loop spent a full round on the whole task.

**Why the test and constitution reviewers run once per task.** They judge the change's tests and its compliance with the repository's rules, and a fix to one finding rarely changes either verdict. Their findings are fixed and verified like any other. They see the work again at the milestone, on the integrated result, which is the version that matters.

**Why review depth is set in the plan.** A documentation update does not carry the risk of a concurrency change, and reviewing both the same way spent most of a run's opposite-family budget on work where a mistake is cheap and visible. Each task row carries a depth. `full`, the default for anything that changes behavior, gets the in-model review and the cross-model counter-review. `light`, for documentation, comments, formatting, regenerated files and renames the typecheck proves, gets the in-model review alone. The human approves the depths with the plan, the orchestrator may raise one but may not lower a behavior-changing task without a waiver, and a `light` task whose diff turns out to change behavior is raised. The whole-milestone counter-review, now the default at each gate, is the cross-model coverage for `light` tasks, for fixes that were only verified, and for how the tasks fit together. What this gives up is stated plainly in the skill's plan presentation: a patch-sized fix is not reviewed across model families on its own, so a subtle defect in one can surface at the milestone instead of in the task.

**Why the orchestrator decides most things.** The human approved a plan so the run could proceed without them, and a stop for something they would wave through costs the time the run was meant to save. Asking about everything the plan or the decision log does not explicitly cover produces questions about bug fixes already made and obvious follow-on work. So the skill draws the line by what kind of decision it is, not by whether it was written down. Plan approval makes the requirements and the declared STOPs the human's. The architecture, task rows and acceptance criteria are the approved means, which the orchestrator keeps working: it keeps or reverts work a sub-agent did beyond its task row, fixes defects found along the way, corrects a row or criterion the code has shown to be wrong, and revises its own earlier decisions. Sub-agents do necessary extra work and report it instead of stopping to ask; reviewers list it as an `unplanned` row for the orchestrator to decide, and judge work by what it does rather than by whether the plan mentioned it.

A human-review reason from the counter-review is treated the same way: as evidence the orchestrator triages, not a verdict. The constitution reviewer cannot see what the human delegated, so a reason that says only "no human approved this" about a decision that belongs to the orchestrator is decided by the orchestrator. A reason that names a decision the human kept, or a kind of change the repository's rules single out for a human (database behavior, a path under an approval rule), still stops the run. Control is kept by visibility rather than by stops: every orchestrator decision is marked as such in `DECISIONS.md` with how to undo it, and is reported in the next closing message, where the human can overturn it.

The run also reads the repository's review policy during planning and tells the human at STOP 0 which triggers will stop the run. A repository that still carries constitution rules from before the default/custom split has triggers written for an earlier, gated workflow, which match on almost every orchestrated task; the skill points that out and recommends refreshing the rules with `/archflow-init`, which is the human's decision.

**Why findings are decided, not sorted.** Severity says how bad a finding is, not whether to fix it now. The orchestrator always fixes criticals. It also fixes a major or minor when leaving it would cost more later: the finding has knock-on effects on tasks that build on it, it is a real bug rather than a style point, or no later task would own it. It defers what does not matter yet, with a reason and an owning task. A deferral is a decision to revisit, so after each milestone gate a deferral pass re-decides every open entry: fix it, carry it, or close it. Nothing stays open past the final STOP, whose report lists each won't-fix so the human can overturn it. Fix rounds stop at a default of three, and because each round after the first only checks a fix, the limit is rarely reached.

**Why no sub-agent waits on a review or is resumed.** A sub-agent's prompt cache lasts about five minutes. An agent that idles while a review runs, or is resumed for a fix, re-reads its whole context uncached. So the orchestrator, whose own cache lasts longer, does all the waiting on reviews, and every fix, check of a fix or answered question goes to a fresh agent that reads one packet and one review file. For the same reason sub-agents run only targeted tests and typecheck-level checks for the files they touched; full builds, the full suite and any slow test groups are the orchestrator's, once per batch. Several agents each compiling a whole workspace at once can overload the machine. A targeted check can still be slow on a busy machine, and an agent sometimes needs a result that takes longer than five minutes, so agents run their commands through the skill's `scripts/wait.sh`. It runs the command in the background and hands control back about every four minutes while it runs; each return is a cheap turn that keeps the cache warm, where a single long blocking call would let it expire. Its `stop` command ends a stuck command together with everything that command started, so an agent never returns with a build still running.

**Why the orchestrator is not the strongest model.** An orchestrator's context is re-read on every turn of a long session, so its model sets most of what a run costs; a run orchestrated on Fable spent more than its judgment calls were worth. The run is designed for an Opus orchestrator at high effort, which keeps the judgment that needs the whole run in view: the requirements, the decision on each finding, the merges, the conversation with the human. A session on another model or a lower effort says so once and carries on. Planning is split by what each part needs:

- cheap explorers (Haiku at xhigh effort by default: it is cheap, and it keeps gaining past high) locate code and write what they find, with file and line pointers, into the run's `research/` folder;
- the orchestrator writes a planning brief: the ask, the settled requirements, the human's decisions and an index of that research;
- a fresh planner sub-agent on the strongest model (Fable at high effort today) reads the brief and the research, looks up whatever else it needs in the code, and writes `PLAN.md`, the decision records, the run's agents and `BRIEF.md`.

The plan is always written this way, and that is one of the skill's hard rules: an error in the plan is repeated in every task built on it, while writing it is one bounded spawn rather than a session. The same planner route details a later milestone and applies any revision that changes scope, architecture, tasks or agents. Small corrections during the run, such as a task row the code has shown to be wrong, stay with the orchestrator.

**Why routing names a model and an effort.** Sub-agents do the reading and writing, mostly on cheaper models than the orchestrator's. The protocol's defaults send well-specified plumbing to Sonnet at medium effort, core and correctness-critical work and its review to Opus at high, the review of `light` tasks to Sonnet, and only the few subtle, hard-to-review tasks, the plan review, and the fidelity and architecture gate lenses to Fable at high. A reviewer is never weaker than the work it reviews. Effort is always named, because the models' own defaults differ, and a struggling task moves up a model before it moves up an effort level. The table is a default the plan adapts and the human approves at STOP 0.

**Why run-specific agents.** During planning the orchestrator can generate `.claude/agents/<name>-<role>.md` from the skill's scaffolds, holding the standing guidance every task of a kind needs (the reference to compare against, how to validate, invariants, review lenses). Prompts stay short, and the human approves the agents together with the plan. The run's files and generated agents are working files to delete before a pull request.

**Requirements and design.** Requirements are sized to the work rather than a separate document stage. Milestones replace per-phase design: a milestone is detailed during planning or "detailed at start", in which case a fresh planner writes its task rows from what the run learned and they are reviewed once without a human gate unless scope or an accepted decision changes: by the plan-stage counter-review when they add architecture or choices the approved plan does not hold, by a fresh in-model plan review when they only continue it.

## Conventions shared by the skills

- **Human gates are conversations.** Skills explain what needs attention, why it matters and the choices, in plain language, and keep digests, JSON and internal paths out unless the user asks for diagnostics.
- **A skill authorizes only what it says.** An explanation request edits nothing; an edit request authorizes the scoped change and its commit; machine-global installs are never authorized by a skill.
- **Skills state intent and trust boundaries, not workarounds.** A rule gets "never" or "must" language only when a human needs it; numbers in the skills are defaults.
- **Payloads.** Small generated JSON can be piped to a payload command on stdin; anything with authored prose or quotes goes in a file passed with `--input`, because shell quoting silently corrupts prose. A command's `{"ok": false}` result also exits nonzero, and the JSON body is the authority for the details.
- **Needs the CLI.** If `archflow-local` is missing or lacks `review`, the installed ArchFlow predates the skill; the skill tells the human to reinstall rather than installing anything itself.
