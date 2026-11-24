# Run planning

This is what the planner needs to write a run's plan, and what the orchestrator needs to brief the planning agents. `PROTOCOL.md` in this directory holds the execution procedure. The planner also reads four of its sections, because the plan sets each of them: "Model routing", "Review depth", "Milestones and gates", and "Task sizing and the plan table". A section named in quotes that is not in this file is in `PROTOCOL.md`.

## Planning agents

Planning runs before the run's generated agents exist, so explorers and the planner are general-purpose sub-agents with the model and effort passed on the spawn. Each gets a complete brief, because it sees none of the conversation, and each is fresh: the rules under "Never resume an idle agent" apply here too.

**Explorer.** One area or question per explorer, on the exploration route. Its prompt names the area, what the run is about in a sentence or two, and the output file `<run dir>/research/<topic>.md`. A useful note lets the planner go straight to the right place:

- what exists, with paths and line pointers, and how the parts connect;
- the conventions the code follows there, including where the same thing is done in more than one way, and the repository instructions that apply;
- constraints, conflicting patterns, or integration seams that affect the ask and leave a real choice open (flag the fork so the orchestrator can clarify it with the human; do not pick a design);
- the commands that build, typecheck and test it, including how to run named test files only, how long the full suite takes, and which test groups are slow;
- what it could not find or is unsure of.

An explorer describes what is there. It does not propose a design, and it says so when a question needs more judgment than a lookup; that question goes to the research route. It returns a few lines: the file it wrote, what it covers, and any open forks or constraints the orchestrator should know before planning.

**Planning brief.** `research/planning.md`, maintained by the orchestrator across clarification rounds, is the planner's starting point: the ask in the human's words, the settled requirements, UX and behavior choices, architecture and integration decisions or constraints, non-goals, any minor residual assumptions, the run branch, the active review triggers, and an index of the research files. Update it as the human answers questions, so multi-round planning survives a session break and a fresh planner starts from the current state.

**Planner.** One fresh sub-agent, on the route its job takes ("Planner routing" in `PROTOCOL.md`). Its prompt names the brief, the run directory, this skill directory, and which of three jobs it has:

- **First plan.** Read the brief, this file, the four sections of `PROTOCOL.md` named at the top of it, and `templates/`. Read the research, then look up in the code whatever the research leaves open; the research is a map, not a limit. Write `PLAN.md` from `templates/PLAN.md`, a `milestones/M<n>.md` from `templates/MILESTONE.md` for each milestone detailed now, the consequential choices as ADRs in `DECISIONS.md` (marked `human` when the brief records the human's decision, `orchestrator` otherwise), the generated agents, and `BRIEF.md`.
- **Revision.** The prompt carries the counter-review points the orchestrator accepted, or the human's revision. Change what they require in the plan, the milestone files, the ADRs, the agents and `BRIEF.md`, and keep the rest.
- **Milestone detail.** For a milestone marked "detailed at start": read `PLAN.md`, `PROGRESS.md` (resume notes, decisions to report) and `DEFERRED.md` (the open deferred findings), read `DECISIONS.md` as an index (`grep -n -A1 '^## ADR'`) and open the decisions the milestone touches, search the session reports in `HISTORY.md` for how the routing has held up (`grep -n 'Routing:'`) without reading the file whole, look at the merged code the milestone builds on, and write `milestones/M<n>.md` from `templates/MILESTONE.md`: the design this milestone adds and its task rows, each with its agent, its review depth and any hatch with its reason (see "Escape hatches"). The whole plan is yours to read: `PLAN.md`, and the earlier milestones' files as far as this milestone builds on them. How much of them to read is your call; the merged code is the better source for what exists. On `fable`, correct the architecture where the run has shown it wrong, and add or revise a domain's agents when the milestone opens a kind of work the roster does not cover; say so in the return. On `opus`, design inside what `PLAN.md` holds: the decisions this milestone needs are yours, and so is correcting a detail the code has shown to be wrong while the requirement behind it is still met. When the milestone needs a change to what a requirement, an architecture decision or an invariant commits the run to, or an agent added or re-scoped, write nothing and return `escalate` with what has to be decided and why.

`PLAN.md` holds the whole run. The template marks the headings of its shared sections with `(shared)`: the agents that execute the run select those sections by that mark and read no other part of the file, so keep the marks, and put nothing an executing agent needs only in an unmarked section. It holds:

- requirements, as the brief settled them, numbered so that each gate and STOP report can account for them one by one;
- the architecture decisions tasks depend on, and the code shape: where the run's new code goes, the one job of each unit it adds, and any existing pattern in the touched code that new work must not copy, with what to do instead. Agents copy the shape they find, so a shape nobody chose is still a decision, made by whichever task got there first;
- invariants every agent follows;
- the commands, in the three tiers of "Where tests run": the task check that agents run on a task's own test files, the merge check, and full validation, with how long the full suite takes today;
- the run's test policy, from the defaults under "What tests to write";
- the agent roster, with what each agent covers and why it is its own agent (see "Run agents");
- model and effort routing, from the defaults under "Model routing", and the escape hatches: which rows get an `opus` implementer or a `fable` reviewer, each with its reason on the row, and their total;
- milestones, each with its gate lenses. The last milestone's always include fidelity and runtime (see "Milestones and gates");
- declared STOPs.

Each milestone's file holds that milestone's design and its task table, with a review depth on every row (see "Review depth"). Write it for the agents that execute it: the orchestrator and the task agents work from the current milestone's file and the plan's `(shared)` sections, and do not read the plan's architecture or another milestone's file. So bring into its "Design" what its tasks need from the architecture and from earlier milestones, saying where each part comes from, and let each row cite the entries it depends on. Only the planner reads the whole plan. A decision later milestones also depend on is recorded in `PLAN.md` as well, so their planners find it.

**What a milestone is.** A milestone is one complete set of work that has to be designed together. Its tasks share a design, and when it ends the result builds, passes and can be run, so its gate judges something whole. Draw the boundary where the design stops being knowable: the first milestone is what has to be built and seen working before the rest can be designed well, and each later one is drawn the same way. Work whose design depends on nothing unbuilt belongs with the work it is designed with, however much of it there is. A declared STOP also ends a milestone, because the human decides there before the run goes on.

A boundary has to buy something. Every later milestone costs a planner, a plan review and a gate, so a milestone is typically tens of tasks, and a handful of tasks that could have been designed with their neighbors are part of that milestone. A run whose whole design can be settled now is one milestone.

**When the ask turns on an unproven technical or quality bet** — a new generative pipeline, an unverified external API, or a representation whose output quality cannot be judged from code alone — do not sink a 30-task M1 into an unvalidated design. Make M1 a small **1–2 task vertical spike** (ending at STOP 1 with real output the human can judge) before detailing the full build in M2. Only reach for a spike when the approach itself is uncertain, not when the design is already clear.

Detail the first milestone's tasks. A later milestone is marked "detailed at start" when earlier work should shape it, which is the usual reason it is a milestone of its own. It is detailed on `opus`, which escalates when it meets an architecture decision it cannot make inside the plan; mark it `fable`, with the reason, only when you know it leaves such a decision open, one that earlier work has to settle. Size tasks so one agent finishes each in a single focused spawn (see "Task sizing and the plan table").

Generate the run's agents as "Run agents" describes, and list them in the plan's agent roster. The cross-model reviewer never sees agent files, so write the standing reference-and-validation guidance and the run's test policy as a short `BRIEF.md` in the run directory, with a section per domain when the run has several; every counter-review receives it.

The planner ends with a short return block: `STATUS: done | needs-decision | escalate`, `FILES:` the paths it wrote, `NOTES:` the main architecture choices, the milestones and the risks in a few lines, and `QUESTIONS:`. The orchestrator reads the plan itself by section. The planner does not commit, and it writes only the run's files and agents.

This is a fallback for residual questions the orchestrator's clarification could not anticipate — not a substitute for settling UX, scope and architecture up front. When the planner still uncovers a question whose answer is the human's (a requirement the brief left open, a product or UX choice exposed only deep in the code), it does not stop: it writes the plan on the answer it would assume, and returns `done` with every such question under QUESTIONS: what is open, what it assumed, and what in the plan changes on the other answer. The orchestrator puts them to the human with the plan, at STOP 0 or in a halt for a milestone detailed mid-run, and only an answer that differs from the assumption goes to a fresh planner, as a revision. One planning pass then serves however many questions there are. The planner returns `needs-decision` without writing a plan only when the whole plan turns on the answer, so that no assumption would leave most of it standing.

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
| `<name>-reviewer` | always | the reviews of those tasks, and the reviews that span the run: deferral, gate lenses, leftovers from a dead session |

- A domain's implementer and reviewer come as a pair, because they share the reference and how to validate against it. The planner may leave out a domain's reviewer when reviewing that work needs nothing the general reviewer lacks.
- When the whole run is one kind of work, the general pair carries its guidance and no other agents are generated.
- There is no separate fixer agent. A fix needs the same guidance as the work it corrects, so a fixer is a fresh spawn of the task's implementer agent in fix mode. It has none of the implementer's context because it is a new agent, not because it is a different definition.
- A gate lens that judges one domain, such as the fidelity of the physics, may go to that domain's reviewer.
- Explorers, the planner and the cross-model reviewers are not generated: each gets what it needs in a brief (`research/planning.md`, `BRIEF.md`).

A task's row names its implementer agent. Its fixes go to that agent, and its reviews to the reviewer of the same domain, or to the general reviewer when the domain has none. Split a task that spans domains. A task that joins two domains goes to the domain whose guidance covers the larger risk, or to the general agent with both interfaces in its packet.

**Writing the guidance.** Fill each scaffold's `Domain guidance` section with what a strong engineer new to this run would not know: the reference and how fidelity is proven, the domain's rules and decisions here, where this work goes wrong, the conventions of that code, including any pattern there that new work must not copy, and the tools it needs. It is not a tutorial on the field. A reviewer's section holds the same reference and validation, plus the lenses to review that work through. The general pair holds only what is true of any task in the run; when no standing guidance exists, generate it from the scaffolds with only the run's paths and commands filled in. Fill `{{skill dir}}` with this skill directory's absolute path, so agents can run `scripts/wait.sh` from any worktree, and give each agent the task check its domain uses. Fill `{{run}}` with the run's name as given, and keep each description's sentence "Spawned only by the <name> orchestrator" as the scaffold has it: `scripts/cleanup.sh` recognizes the run's agents by their file name and that sentence, and leaves any other file in `.claude/agents/` alone.

## What tests to write

Every test a task adds is run again by everything after it, for as long as the code lives. A suite that gains one slow test per task ends up setting how long every later task takes, so the run decides what a test costs as deliberately as what it covers. The planner writes the run's test policy into the plan's §4 and into `BRIEF.md`, starting from these defaults:

- **A test earns its place by a failure no other test would catch.** Coverage is the distinct failures the suite catches, not the number of tests or of lines run.
- **Test at the lowest layer where the failure can happen.** Logic is tested in-process, with its cases in a table. A real boundary (a spawned process, git, a database, the network, a browser) gets the few tests that prove the wiring works, not one per case.
- **A criterion needs evidence, which is not always a new test.** Extend an existing test or add a case to its table when that covers it.
- **A fix's regression test is the cheapest test that fails without the fix,** usually one more case beside the ones already there.
- **Keep setup cheap.** Build an expensive fixture once per file, and wait on a condition or a fake clock instead of a real delay.
- **A new test belongs to the fast tier,** the one the task check runs. A test that has to be slow says, in the test, what it proves that a fast one cannot, and joins the slow group that only full validation runs.
- **Replace instead of adding.** When a new test covers what an older one did, remove the older one in the same task.
